import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { prisma } from "../prisma.js";
import { advanceDevAgentJob } from "./dev-agent-worker.js";
import { applyFileOps, commitChanges, InvalidFileOpsError, parseFileOps, safeResolveWithinWorktree } from "./dev-agent-apply.js";

class StopTick extends Error {
  constructor(public phase: any) {
    super("stop-tick-sentinel");
  }
}
const fakeReDelay = async (_ms: number, phase: any) => {
  throw new StopTick(phase);
};

test("parseFileOps accepts a well-formed array, including one wrapped in a markdown code fence", () => {
  const ops = parseFileOps('```json\n[{"path":"a.ts","action":"create","content":"x"}]\n```');
  assert.deepEqual(ops, [{ path: "a.ts", action: "create", content: "x" }]);
});

test("parseFileOps rejects non-JSON, non-array, empty array, and missing content", () => {
  assert.throws(() => parseFileOps("not json"), InvalidFileOpsError);
  assert.throws(() => parseFileOps('{"path":"a.ts"}'), InvalidFileOpsError);
  assert.throws(() => parseFileOps("[]"), InvalidFileOpsError);
  assert.throws(() => parseFileOps('[{"path":"a.ts","action":"modify"}]'), InvalidFileOpsError);
  assert.throws(() => parseFileOps('[{"path":"a.ts","action":"rewrite","content":"x"}]'), InvalidFileOpsError);
});

test("safeResolveWithinWorktree rejects path traversal and absolute paths", () => {
  assert.throws(() => safeResolveWithinWorktree("/tmp/wt", "../../etc/passwd"), InvalidFileOpsError);
  assert.throws(() => safeResolveWithinWorktree("/tmp/wt", "/etc/passwd"), InvalidFileOpsError);
  assert.doesNotThrow(() => safeResolveWithinWorktree("/tmp/wt", "src/nested/file.ts"));
});

async function makeTempRepo() {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "tm-dev-agent-apply-test-"));
  await execa("git", ["init", "-q"], { cwd: repo });
  await execa("git", ["config", "user.email", "test@example.com"], { cwd: repo });
  await execa("git", ["config", "user.name", "Test"], { cwd: repo });
  await fs.writeFile(path.join(repo, "README.md"), "hello\n");
  await execa("git", ["add", "."], { cwd: repo });
  await execa("git", ["commit", "-q", "-m", "initial"], { cwd: repo });
  return repo;
}

test("applyFileOps + commitChanges really write files and really commit, in a real local repo", async (t) => {
  const repo = await makeTempRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }).catch(() => {}));

  const changed = await applyFileOps(repo, [
    { path: "src/new-file.ts", action: "create", content: "export const x = 1;\n" },
    { path: "README.md", action: "modify", content: "updated\n" },
  ]);
  assert.deepEqual(changed, [
    { path: "src/new-file.ts", content: "export const x = 1;\n" },
    { path: "README.md", content: "updated\n" },
  ]);

  assert.equal(await fs.readFile(path.join(repo, "src", "new-file.ts"), "utf8"), "export const x = 1;\n");
  assert.equal(await fs.readFile(path.join(repo, "README.md"), "utf8"), "updated\n");

  const { committed } = await commitChanges(repo, "test commit");
  assert.equal(committed, true);
  const log = await execa("git", ["log", "--oneline", "-1"], { cwd: repo });
  assert.match(log.stdout, /test commit/);
});

test("applyFileOps really deletes a file", async (t) => {
  const repo = await makeTempRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }).catch(() => {}));
  await applyFileOps(repo, [{ path: "to-delete.txt", action: "create", content: "bye\n" }]);
  await applyFileOps(repo, [{ path: "to-delete.txt", action: "delete" }]);
  await assert.rejects(fs.stat(path.join(repo, "to-delete.txt")));
});

test("commitChanges is a real no-op (not an error) when there is genuinely nothing to commit", async (t) => {
  const repo = await makeTempRepo();
  t.after(() => fs.rm(repo, { recursive: true, force: true }).catch(() => {}));
  const result = await commitChanges(repo, "nothing to see here");
  assert.equal(result.committed, false);
});

// --- Integration through the real advanceDevAgentJob, with a stubbed LLM response fed
// through the real apply-and-commit path (no real OpenAI call) ---

async function setupRun() {
  const repo = await makeTempRepo();
  const prevRoot = process.env.TM_LOCAL_REPO_ROOT;
  process.env.TM_LOCAL_REPO_ROOT = repo;

  const project = await prisma.project.findFirst({ orderBy: { createdAt: "asc" } });
  assert.ok(project, "a local test Postgres with at least one Project row is required for this test");

  const operatorJob = await prisma.operatorJob.create({
    data: { projectId: project!.id, type: "autonomousDev", status: "running", requestedBy: "test" },
  });
  const run = await prisma.devAgentRun.create({
    data: { projectId: project!.id, operatorJobId: operatorJob.id, requestedBy: "test", status: "queued" },
  });
  const opJobCtx = { id: operatorJob.id, projectId: project!.id, type: "autonomousDev", requestedBy: "test" };

  const cleanup = async () => {
    process.env.TM_LOCAL_REPO_ROOT = prevRoot;
    await prisma.devAgentIteration.deleteMany({ where: { devAgentRunId: run.id } }).catch(() => {});
    await prisma.devAgentRun.delete({ where: { id: run.id } }).catch(() => {});
    await prisma.operatorJob.delete({ where: { id: operatorJob.id } }).catch(() => {});
    await execa("git", ["worktree", "prune"], { cwd: repo }).catch(() => {});
    await fs.rm(repo, { recursive: true, force: true }).catch(() => {});
  };
  return { repo, run, opJobCtx, cleanup };
}

test("a stubbed LLM file-ops response is really applied and committed in the run's own worktree, and recorded on the iteration", async (t) => {
  const ctx = await setupRun();
  await prisma.devAgentRun.update({ where: { id: ctx.run.id }, data: { testCommand: "true" } });
  t.after(ctx.cleanup);

  await advanceDevAgentJob(ctx.opJobCtx, fakeReDelay, {
    requestApproval: async () => "approved",
    codePhase: async ({ worktreePath, iterationNumber }) => {
      const raw = JSON.stringify([{ path: "agent-output.ts", action: "create", content: "export const hello = 'world';\n" }]);
      const ops = parseFileOps(raw);
      const filesChanged = await applyFileOps(worktreePath, ops);
      await commitChanges(worktreePath, `dev-agent: iteration ${iterationNumber}`);
      return { summary: "wrote agent-output.ts", filesChanged, costUsd: 0.002 };
    },
    runTestCommand: async () => ({ passed: true, output: "ok" }),
  });

  const updated = await prisma.devAgentRun.findUnique({ where: { id: ctx.run.id } });
  assert.equal(updated?.status, "succeeded");
  assert.ok(updated?.worktreePath);

  const writtenPath = path.join(updated!.worktreePath!, "agent-output.ts");
  assert.equal(await fs.readFile(writtenPath, "utf8"), "export const hello = 'world';\n");

  const log = await execa("git", ["log", "--oneline", "-1"], { cwd: updated!.worktreePath! });
  assert.match(log.stdout, /dev-agent: iteration 1/);

  const iteration = await prisma.devAgentIteration.findFirst({ where: { devAgentRunId: ctx.run.id } });
  assert.deepEqual(iteration?.filesChanged, [{ path: "agent-output.ts", content: "export const hello = 'world';\n" }]);
});

test("a malformed LLM response fails the run closed: iteration recorded as failed, nothing written, worktree removed", async (t) => {
  const ctx = await setupRun();
  t.after(ctx.cleanup);

  await assert.rejects(
    advanceDevAgentJob(ctx.opJobCtx, fakeReDelay, {
      requestApproval: async () => "approved",
      codePhase: async () => {
        parseFileOps("not valid json at all"); // throws InvalidFileOpsError
        throw new Error("unreachable");
      },
    }),
    /Code phase failed/
  );

  const updated = await prisma.devAgentRun.findUnique({ where: { id: ctx.run.id } });
  assert.equal(updated?.status, "failed");
  assert.match(updated?.error ?? "", /Code phase failed/);
  await assert.rejects(fs.stat(updated!.worktreePath!), "the worktree must be torn down, nothing left behind");

  const iteration = await prisma.devAgentIteration.findFirst({ where: { devAgentRunId: ctx.run.id } });
  assert.ok(iteration, "a failed iteration row must still be recorded, not silently dropped");
  assert.deepEqual(iteration?.filesChanged, []);
});

test("a path-traversal attempt in the LLM response fails the run closed before anything is written", async (t) => {
  const ctx = await setupRun();
  t.after(ctx.cleanup);

  let worktreeAtTimeOfAttempt = "";
  await assert.rejects(
    advanceDevAgentJob(ctx.opJobCtx, fakeReDelay, {
      requestApproval: async () => "approved",
      codePhase: async ({ worktreePath }) => {
        worktreeAtTimeOfAttempt = worktreePath;
        const ops = parseFileOps(JSON.stringify([{ path: "../../etc/passwd", action: "create", content: "pwned" }]));
        await applyFileOps(worktreePath, ops); // throws InvalidFileOpsError before any write
        return { summary: "unreachable", filesChanged: [], costUsd: 0 };
      },
    }),
    /escapes the worktree root/
  );

  const updated = await prisma.devAgentRun.findUnique({ where: { id: ctx.run.id } });
  assert.equal(updated?.status, "failed");
  assert.match(updated?.error ?? "", /escapes the worktree root/);
  // The traversal target must never have been created anywhere relative to the worktree's parent.
  await assert.rejects(fs.stat(path.resolve(worktreeAtTimeOfAttempt, "..", "..", "etc", "passwd")));
});

test("commitChanges works where git has no user identity (production containers) and authors as the Dev Agent", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tm-dev-agent-noident-"));
  const emptyConfig = path.join(dir, "..", `${path.basename(dir)}-gitconfig`);
  await fs.writeFile(emptyConfig, "");
  const saved = { global: process.env.GIT_CONFIG_GLOBAL, nosystem: process.env.GIT_CONFIG_NOSYSTEM, author: process.env.GIT_AUTHOR_NAME, email: process.env.GIT_AUTHOR_EMAIL, cname: process.env.GIT_COMMITTER_NAME, cemail: process.env.GIT_COMMITTER_EMAIL };
  // Simulate the container: no global/system git config and no identity in the environment.
  process.env.GIT_CONFIG_GLOBAL = emptyConfig;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  for (const k of ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"]) delete process.env[k];
  t.after(async () => {
    const restore = (k: string, v: string | undefined) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
    restore("GIT_CONFIG_GLOBAL", saved.global); restore("GIT_CONFIG_NOSYSTEM", saved.nosystem);
    restore("GIT_AUTHOR_NAME", saved.author); restore("GIT_AUTHOR_EMAIL", saved.email); restore("GIT_COMMITTER_NAME", saved.cname); restore("GIT_COMMITTER_EMAIL", saved.cemail);
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(emptyConfig, { force: true });
  });
  await execa("git", ["init", "-q"], { cwd: dir });
  await assert.rejects(execa("git", ["commit", "--allow-empty", "-m", "no identity"], { cwd: dir }), /Author identity unknown|Please tell me who you are/, "reproduces the production failure without the fix");
  await fs.writeFile(path.join(dir, "signup.spec.ts"), "export {};\n");
  const { committed } = await commitChanges(dir, "dev-agent: iteration 1 - create signup.spec.ts");
  assert.equal(committed, true);
  const author = (await execa("git", ["log", "-1", "--format=%an <%ae>"], { cwd: dir })).stdout;
  assert.equal(author, "TestMind Dev Agent <dev-agent@testmind.invalid>");
});
