import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { prisma } from "../prisma.js";
import { advanceDevAgentJob } from "./dev-agent-worker.js";

class StopTick extends Error {
  constructor(public phase: any) {
    super("stop-tick-sentinel");
  }
}
const fakeReDelay = async (_ms: number, phase: any) => {
  throw new StopTick(phase);
};

async function setupRun(overrides: Partial<{ status: string; spentUsd: number; budgetUsd: number | null; maxIterations: number }> = {}) {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "tm-dev-agent-worker-test-repo-"));
  await execa("git", ["init", "-q"], { cwd: repo });
  await execa("git", ["config", "user.email", "test@example.com"], { cwd: repo });
  await execa("git", ["config", "user.name", "Test"], { cwd: repo });
  await fs.writeFile(path.join(repo, "README.md"), "hello\n");
  await execa("git", ["add", "."], { cwd: repo });
  await execa("git", ["commit", "-q", "-m", "initial"], { cwd: repo });

  const prevRoot = process.env.TM_LOCAL_REPO_ROOT;
  process.env.TM_LOCAL_REPO_ROOT = repo;

  const project = await prisma.project.findFirst({ orderBy: { createdAt: "asc" } });
  assert.ok(project, "a local test Postgres with at least one Project row is required for this test");

  const operatorJob = await prisma.operatorJob.create({
    data: { projectId: project!.id, type: "autonomousDev", status: "running", requestedBy: "test" },
  });
  const run = await prisma.devAgentRun.create({
    data: {
      projectId: project!.id,
      operatorJobId: operatorJob.id,
      requestedBy: "test",
      status: (overrides.status ?? "queued") as any,
      spentUsd: overrides.spentUsd ?? 0,
      budgetUsd: overrides.budgetUsd ?? null,
      maxIterations: overrides.maxIterations ?? 5,
    },
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

  return { repo, project: project!, operatorJob, run, opJobCtx, cleanup };
}

test("fresh run: requests approval, creates a worktree, runs one iteration, and re-delays with the right checkpoint when the test fails", async (t) => {
  const ctx = await setupRun({ status: "queued" });
  await prisma.devAgentRun.update({ where: { id: ctx.run.id }, data: { testCommand: "true" } });
  t.after(ctx.cleanup);

  let approvalCalled = false;
  let codePhaseCalled = false;
  let testCommandCalled = false;
  let caught: StopTick | undefined;

  try {
    await advanceDevAgentJob(ctx.opJobCtx, fakeReDelay, {
      requestApproval: async (opts) => {
        approvalCalled = true;
        assert.equal(opts.actionType, "patch_code");
        return "approved";
      },
      codePhase: async () => {
        codePhaseCalled = true;
        return { summary: "did a thing", filesChanged: [], costUsd: 0 };
      },
      runTestCommand: async () => {
        testCommandCalled = true;
        return { passed: false, output: "1 failed" };
      },
    });
  } catch (e) {
    caught = e as StopTick;
  }

  assert.ok(caught instanceof StopTick, "a failing test must produce a real re-delay, not a silent return");
  assert.equal(caught!.phase.kind, "dev_agent_iterate");
  assert.equal(caught!.phase.devAgentRunId, ctx.run.id);
  assert.equal(approvalCalled, true);
  assert.equal(codePhaseCalled, true);
  assert.equal(testCommandCalled, true);
  const afterApproval = await prisma.devAgentRun.findUnique({ where: { id: ctx.run.id } });
  assert.equal(afterApproval?.status, "running");
  assert.ok(afterApproval?.worktreePath);
  const iterations = await prisma.devAgentIteration.count({ where: { devAgentRunId: ctx.run.id } });
  assert.equal(iterations, 1);
});

test("paused run re-delays without doing any iteration work", async (t) => {
  const ctx = await setupRun({ status: "paused" });
  t.after(ctx.cleanup);

  let codePhaseCalled = false;
  await assert.rejects(
    advanceDevAgentJob(ctx.opJobCtx, fakeReDelay, {
      codePhase: async () => {
        codePhaseCalled = true;
        return { summary: "", filesChanged: [], costUsd: 0 };
      },
    }),
    StopTick
  );
  assert.equal(codePhaseCalled, false, "a paused run must never reach the code phase");
  const iterations = await prisma.devAgentIteration.count({ where: { devAgentRunId: ctx.run.id } });
  assert.equal(iterations, 0);
});

test("canceled run returns cleanly with no iteration work and no re-delay", async (t) => {
  const ctx = await setupRun({ status: "canceled" });
  t.after(ctx.cleanup);

  let codePhaseCalled = false;
  await advanceDevAgentJob(ctx.opJobCtx, fakeReDelay, {
    codePhase: async () => {
      codePhaseCalled = true;
      return { summary: "", filesChanged: [], costUsd: 0 };
    },
  }); // must NOT throw StopTick - no re-delay should be scheduled for a canceled run
  assert.equal(codePhaseCalled, false);
});

test("budget exceeded before the next step fails the run without calling codePhase, and removes the worktree", async (t) => {
  const ctx = await setupRun({ status: "running", spentUsd: 0.999, budgetUsd: 1.0 });
  // Give it a real worktree to remove, matching what a genuinely-running run would have.
  const worktreePath = path.join(os.tmpdir(), "tm-dev-agent-worktrees", ctx.run.id);
  await execa("git", ["worktree", "add", worktreePath, "-b", `dev-agent/${ctx.run.id}`], { cwd: ctx.repo });
  await prisma.devAgentRun.update({ where: { id: ctx.run.id }, data: { worktreePath, workBranch: `dev-agent/${ctx.run.id}` } });
  t.after(ctx.cleanup);

  let codePhaseCalled = false;
  await advanceDevAgentJob(ctx.opJobCtx, fakeReDelay, {
    codePhase: async () => {
      codePhaseCalled = true;
      return { summary: "", filesChanged: [], costUsd: 0 };
    },
  });

  assert.equal(codePhaseCalled, false, "must refuse BEFORE the expensive operation, not after");
  const updated = await prisma.devAgentRun.findUnique({ where: { id: ctx.run.id } });
  assert.equal(updated?.status, "failed");
  assert.match(updated?.error ?? "", /Budget exceeded/);
  await assert.rejects(fs.stat(worktreePath), "the worktree must be torn down on budget failure");
});

test("max iterations reached fails the run without creating a new iteration, and removes the worktree", async (t) => {
  const ctx = await setupRun({ status: "running", maxIterations: 2 });
  const worktreePath = path.join(os.tmpdir(), "tm-dev-agent-worktrees", ctx.run.id);
  await execa("git", ["worktree", "add", worktreePath, "-b", `dev-agent/${ctx.run.id}`], { cwd: ctx.repo });
  await prisma.devAgentRun.update({ where: { id: ctx.run.id }, data: { worktreePath, workBranch: `dev-agent/${ctx.run.id}` } });
  await prisma.devAgentIteration.createMany({
    data: [
      { devAgentRunId: ctx.run.id, iterationNumber: 1, phase: "code" },
      { devAgentRunId: ctx.run.id, iterationNumber: 2, phase: "code" },
    ],
  });
  t.after(ctx.cleanup);

  let codePhaseCalled = false;
  await advanceDevAgentJob(ctx.opJobCtx, fakeReDelay, {
    codePhase: async () => {
      codePhaseCalled = true;
      return { summary: "", filesChanged: [], costUsd: 0 };
    },
  });

  assert.equal(codePhaseCalled, false);
  const updated = await prisma.devAgentRun.findUnique({ where: { id: ctx.run.id } });
  assert.equal(updated?.status, "failed");
  assert.match(updated?.error ?? "", /Max iterations/);
  const count = await prisma.devAgentIteration.count({ where: { devAgentRunId: ctx.run.id } });
  assert.equal(count, 2, "no new iteration row beyond the pre-existing two");
});

test("a passing test marks the run succeeded and leaves the worktree in place (not torn down)", async (t) => {
  const ctx = await setupRun({ status: "queued" });
  t.after(ctx.cleanup);

  await advanceDevAgentJob(ctx.opJobCtx, fakeReDelay, {
    requestApproval: async () => "approved",
    codePhase: async () => ({ summary: "done", filesChanged: [{ path: "a.ts", content: "x" }], costUsd: 0.001 }),
    runTestCommand: async () => ({ passed: true, output: "ok" }),
  }); // must NOT throw - no re-delay once succeeded

  const updated = await prisma.devAgentRun.findUnique({ where: { id: ctx.run.id } });
  assert.equal(updated?.status, "succeeded");
  assert.ok(updated?.worktreePath);
  const stat = await fs.stat(updated!.worktreePath!);
  assert.ok(stat.isDirectory(), "worktree must still exist after success");
});

test("denied/unresolvable approval fails the run closed and never creates a worktree (correction #3)", async (t) => {
  const ctx = await setupRun({ status: "queued" });
  t.after(ctx.cleanup);

  await assert.rejects(
    advanceDevAgentJob(ctx.opJobCtx, fakeReDelay, {
      requestApproval: async () => {
        throw new Error("Approval denied");
      },
    })
  );
  const updated = await prisma.devAgentRun.findUnique({ where: { id: ctx.run.id } });
  assert.equal(updated?.status, "failed");
  assert.match(updated?.error ?? "", /not authorized/);
  assert.equal(updated?.worktreePath, null);
});
