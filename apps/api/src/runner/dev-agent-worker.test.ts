import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { prisma } from "../prisma.js";
import { advanceDevAgentJob, buildCodePhasePrompt, listRepoTestFiles } from "./dev-agent-worker.js";
import { suiteDirForRun } from "./dev-agent-suite.js";

class StopTick extends Error {
  constructor(public phase: any) {
    super("stop-tick-sentinel");
  }
}
const fakeReDelay = async (_ms: number, phase: any) => {
  throw new StopTick(phase);
};

async function setupRun(overrides: Partial<{ status: string; spentUsd: number; budgetUsd: number | null; maxIterations: number; baseUrl: string | null }> = {}) {
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
      baseUrl: overrides.baseUrl ?? null,
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
    await fs.rm(suiteDirForRun({ id: run.id, projectId: project!.id, requestedBy: "test" }), { recursive: true, force: true }).catch(() => {});
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
  // Must reject, not resolve: operator-worker.ts's dispatcher only marks the OperatorJob
  // 'failed' when advanceDevAgentJob throws - a resolved promise here would be misreported
  // as a succeeded job despite the DevAgentRun itself being failed.
  await assert.rejects(
    advanceDevAgentJob(ctx.opJobCtx, fakeReDelay, {
      codePhase: async () => {
        codePhaseCalled = true;
        return { summary: "", filesChanged: [], costUsd: 0 };
      },
    }),
    /Budget exceeded/
  );

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
  await assert.rejects(
    advanceDevAgentJob(ctx.opJobCtx, fakeReDelay, {
      codePhase: async () => {
        codePhaseCalled = true;
        return { summary: "", filesChanged: [], costUsd: 0 };
      },
    }),
    /Max iterations/
  );

  assert.equal(codePhaseCalled, false);
  const updated = await prisma.devAgentRun.findUnique({ where: { id: ctx.run.id } });
  assert.equal(updated?.status, "failed");
  assert.match(updated?.error ?? "", /Max iterations/);
  const count = await prisma.devAgentIteration.count({ where: { devAgentRunId: ctx.run.id } });
  assert.equal(count, 2, "no new iteration row beyond the pre-existing two");
});

test("a passing executed test marks the run succeeded and leaves the worktree in place (not torn down)", async (t) => {
  const ctx = await setupRun({ status: "queued" });
  await prisma.devAgentRun.update({ where: { id: ctx.run.id }, data: { testCommand: "true" } });
  t.after(ctx.cleanup);

  let runTestCommandCalled = false;
  await advanceDevAgentJob(ctx.opJobCtx, fakeReDelay, {
    requestApproval: async () => "approved",
    codePhase: async () => ({ summary: "done", filesChanged: [{ path: "a.ts", content: "x" }], costUsd: 0.001 }),
    runTestCommand: async () => {
      runTestCommandCalled = true;
      return { passed: true, output: "ok" };
    },
  }); // must NOT throw - no re-delay once succeeded

  assert.equal(runTestCommandCalled, true, "success must come from an actually executed test");
  const updated = await prisma.devAgentRun.findUnique({ where: { id: ctx.run.id } });
  assert.equal(updated?.status, "succeeded");
  assert.ok(updated?.worktreePath);
  const stat = await fs.stat(updated!.worktreePath!);
  assert.ok(stat.isDirectory(), "worktree must still exist after success");
});

test("no test command configured ends the run 'unverified', never 'succeeded', without executing anything", async (t) => {
  const ctx = await setupRun({ status: "queued" });
  t.after(ctx.cleanup);

  let runTestCommandCalled = false;
  await advanceDevAgentJob(ctx.opJobCtx, fakeReDelay, {
    requestApproval: async () => "approved",
    codePhase: async () => ({ summary: "did a thing", filesChanged: [{ path: "a.ts", content: "x" }], costUsd: 0.001 }),
    runTestCommand: async () => {
      runTestCommandCalled = true;
      return { passed: true, output: "ok" };
    },
  }); // must NOT throw - 'unverified' is terminal, not a failure to re-delay from

  assert.equal(runTestCommandCalled, false, "nothing should be executed when there is no test command to run");
  const updated = await prisma.devAgentRun.findUnique({ where: { id: ctx.run.id } });
  assert.equal(updated?.status, "unverified");
  assert.notEqual(updated?.status, "succeeded");
  const iterations = await prisma.devAgentIteration.findMany({ where: { devAgentRunId: ctx.run.id } });
  assert.equal(iterations.length, 1, "exactly one iteration - no looping without a real check to loop on");
  assert.equal((iterations[0].testResult as any)?.passed, false, "the iteration's own recorded result must not claim a pass that never happened");
});

test("no user test command: the auto-detected command is executed, recorded, and a pass ends 'succeeded'", async (t) => {
  const ctx = await setupRun({ status: "queued" });
  t.after(ctx.cleanup);

  let executedCommand: string | null = null;
  await advanceDevAgentJob(ctx.opJobCtx, fakeReDelay, {
    requestApproval: async () => "approved",
    codePhase: async () => ({ summary: "spec", filesChanged: [{ path: "src/a.ts", content: "x" }], costUsd: 0.001 }),
    detectTestCommand: (_wt, files) => ({ command: `pnpm exec playwright test ${files.join(" ")}`, framework: "playwright", packageManager: "pnpm", reason: "Playwright via pnpm" }),
    runTestCommand: async (_wt, command) => { executedCommand = command; return { passed: true, output: "1 passed" }; },
  });

  assert.equal(executedCommand, "pnpm exec playwright test src/a.ts");
  const updated = await prisma.devAgentRun.findUnique({ where: { id: ctx.run.id } });
  assert.equal(updated?.status, "succeeded");
  const [it] = await prisma.devAgentIteration.findMany({ where: { devAgentRunId: ctx.run.id } });
  assert.equal((it.testResult as any).autoDetected, true);
  assert.equal((it.testResult as any).command, "pnpm exec playwright test src/a.ts");
});

test("no user test command: a failing auto-detected run is not success and iterates; no detectable config ends 'unverified' with the reason", async (t) => {
  const failing = await setupRun({ status: "queued" });
  t.after(failing.cleanup);
  await assert.rejects(
    advanceDevAgentJob(failing.opJobCtx, fakeReDelay, {
      requestApproval: async () => "approved",
      codePhase: async () => ({ summary: "spec", filesChanged: [{ path: "tests/a.spec.ts", content: "x" }], costUsd: 0.001 }),
      detectTestCommand: () => ({ command: "npm test", framework: "script", packageManager: "npm", reason: "test script" }),
      runTestCommand: async () => ({ passed: false, output: "1 failed" }),
    }),
    StopTick,
  );
  assert.notEqual((await prisma.devAgentRun.findUnique({ where: { id: failing.run.id } }))?.status, "succeeded");

  const none = await setupRun({ status: "queued" });
  t.after(none.cleanup);
  let ran = false;
  await advanceDevAgentJob(none.opJobCtx, fakeReDelay, {
    requestApproval: async () => "approved",
    codePhase: async () => ({ summary: "spec", filesChanged: [{ path: "tests/a.spec.ts", content: "x" }], costUsd: 0.001 }),
    detectTestCommand: () => ({ command: null, reason: "No package.json in the repository." }),
    runTestCommand: async () => { ran = true; return { passed: true, output: "" }; },
  });
  assert.equal(ran, false);
  const run = await prisma.devAgentRun.findUnique({ where: { id: none.run.id } });
  assert.equal(run?.status, "unverified");
  assert.match(run?.error ?? "", /No package\.json/);
});

test("resuming a run stuck at 'awaitingApproval' (e.g. after a worker crash/restart) re-requests approval instead of silently completing with nothing done", async (t) => {
  const ctx = await setupRun({ status: "awaitingApproval" });
  await prisma.devAgentRun.update({ where: { id: ctx.run.id }, data: { testCommand: "true" } });
  t.after(ctx.cleanup);

  let approvalCalled = false;
  let codePhaseCalled = false;
  await advanceDevAgentJob(ctx.opJobCtx, fakeReDelay, {
    requestApproval: async () => {
      approvalCalled = true;
      return "approved";
    },
    codePhase: async () => ({ summary: "done", filesChanged: [], costUsd: 0 }),
    runTestCommand: async () => {
      codePhaseCalled = true;
      return { passed: true, output: "ok" };
    },
  });

  assert.equal(approvalCalled, true, "a stale 'awaitingApproval' run must re-request approval on resume, never silently fall through");
  assert.equal(codePhaseCalled, true, "once re-approved it must actually proceed, not just stop");
  const updated = await prisma.devAgentRun.findUnique({ where: { id: ctx.run.id } });
  assert.equal(updated?.status, "succeeded");
  assert.ok(updated?.worktreePath, "resuming must actually create the worktree that was never created the first time");
});

test("resuming a stuck 'awaitingApproval' run whose worktree/branch was already half-created by a prior crashed attempt still succeeds (no 'branch already exists')", async (t) => {
  const ctx = await setupRun({ status: "awaitingApproval" });
  await prisma.devAgentRun.update({ where: { id: ctx.run.id }, data: { testCommand: "true" } });
  t.after(ctx.cleanup);

  // Simulate a prior attempt that got as far as creating the worktree/branch before the
  // process died, without ever reaching the "running" status update.
  const staleWorktreePath = path.join(os.tmpdir(), "tm-dev-agent-worktrees", ctx.run.id);
  await execa("git", ["worktree", "add", staleWorktreePath, "-b", `dev-agent/${ctx.run.id}`], { cwd: ctx.repo });

  await advanceDevAgentJob(ctx.opJobCtx, fakeReDelay, {
    requestApproval: async () => "approved",
    codePhase: async () => ({ summary: "done", filesChanged: [], costUsd: 0 }),
    runTestCommand: async () => ({ passed: true, output: "ok" }),
  });

  const updated = await prisma.devAgentRun.findUnique({ where: { id: ctx.run.id } });
  assert.equal(updated?.status, "succeeded", "a leftover worktree/branch from a crashed attempt must not permanently block retrying this run");
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

test("discovery runs exactly once (at worktree creation) and is cached - never re-invoked on later iterations", async (t) => {
  const ctx = await setupRun({ status: "queued", baseUrl: "https://example.test" });
  await prisma.devAgentRun.update({ where: { id: ctx.run.id }, data: { testCommand: "true" } });
  t.after(ctx.cleanup);

  let resolveDiscoveryCalls = 0;
  const fakeContext = { baseUrl: "https://example.test", totalRoutes: 1, routes: [{ path: "/", status: 200, headings: ["Home"], formCount: 0, formFields: [], buttons: [] }] };

  let caught: StopTick | undefined;
  try {
    // First tick: queued -> running, discovery should run once here.
    await advanceDevAgentJob(ctx.opJobCtx, fakeReDelay, {
      requestApproval: async () => "approved",
      resolveDiscovery: async () => {
        resolveDiscoveryCalls += 1;
        return { context: fakeContext, unavailableReason: null };
      },
      codePhase: async () => ({ summary: "", filesChanged: [], costUsd: 0 }),
      runTestCommand: async () => ({ passed: false, output: "1 failed" }),
    });
  } catch (e) {
    caught = e as StopTick;
  }
  assert.ok(caught instanceof StopTick, "a failing test must re-delay into iteration 2");

  const afterFirstTick = await prisma.devAgentRun.findUnique({ where: { id: ctx.run.id } });
  assert.deepEqual(afterFirstTick?.discoveryContextJson, { context: fakeContext, unavailableReason: null });
  assert.equal(resolveDiscoveryCalls, 1);

  // Second tick (iteration 2): discovery must NOT be invoked again, and the cached
  // context must be unchanged.
  let caught2: StopTick | undefined;
  try {
    await advanceDevAgentJob(ctx.opJobCtx, fakeReDelay, {
      resolveDiscovery: async () => {
        resolveDiscoveryCalls += 1;
        return { context: fakeContext, unavailableReason: null };
      },
      codePhase: async () => ({ summary: "", filesChanged: [], costUsd: 0 }),
      runTestCommand: async () => ({ passed: false, output: "1 failed again" }),
    });
  } catch (e) {
    caught2 = e as StopTick;
  }
  assert.ok(caught2 instanceof StopTick);
  assert.equal(resolveDiscoveryCalls, 1, "discovery must not be re-run on a later iteration of the same run");
});

test("a run with no resolvable base URL skips discovery gracefully and still proceeds", async (t) => {
  const ctx = await setupRun({ status: "queued" }); // no baseUrl, no environmentId
  // The ambient fixture Project's own sharedSteps.baseUrl/repoUrl are untested and may
  // already resolve to something (set by unrelated earlier QA/discovery activity on this
  // shared local DB) - neutralize them so "nothing resolves" is actually guaranteed here,
  // not coincidental, then restore afterward.
  const originalProject = await prisma.project.findUnique({ where: { id: ctx.project.id }, select: { sharedSteps: true, repoUrl: true } });
  await prisma.project.update({ where: { id: ctx.project.id }, data: { sharedSteps: {}, repoUrl: "git@github.com:example/example.git" } });
  t.after(async () => {
    await prisma.project.update({ where: { id: ctx.project.id }, data: { sharedSteps: originalProject?.sharedSteps ?? {}, repoUrl: originalProject?.repoUrl ?? null } }).catch(() => {});
  });
  t.after(ctx.cleanup);
  await prisma.devAgentRun.update({ where: { id: ctx.run.id }, data: { testCommand: "true" } });

  let resolveDiscoveryCalled = false;
  await advanceDevAgentJob(ctx.opJobCtx, fakeReDelay, {
    requestApproval: async () => "approved",
    resolveDiscovery: async () => {
      resolveDiscoveryCalled = true;
      return { context: null, unavailableReason: null };
    },
    codePhase: async () => ({ summary: "done", filesChanged: [], costUsd: 0 }),
    runTestCommand: async () => ({ passed: true, output: "ok" }),
  });

  assert.equal(resolveDiscoveryCalled, false, "resolveDiscovery is never called when no base URL resolves at all");
  const updated = await prisma.devAgentRun.findUnique({ where: { id: ctx.run.id } });
  assert.equal(updated?.status, "succeeded", "a missing base URL must not fail the run");
  assert.deepEqual(updated?.discoveryContextJson, { context: null, unavailableReason: "no-base-url" });
});

test("buildCodePhasePrompt: includes real site context, states an honest reason when unavailable, lists existing tests, and includes prior-failure context only on iteration 2+", () => {
  const grounded = buildCodePhasePrompt({
    instructionText: "generate a test for the pricing page",
    iterationNumber: 1,
    discoveryContext: {
      baseUrl: "https://example.test",
      totalRoutes: 1,
      routes: [{ path: "/pricing", status: 200, headings: ["Pricing"], formCount: 0, formFields: [], buttons: ["Choose Plan"] }],
    },
    existingTestPaths: ["tests/loginTest.spec.ts"],
    priorIteration: null,
  });
  assert.match(grounded, /\/pricing/);
  assert.match(grounded, /Choose Plan/);
  assert.match(grounded, /tests\/loginTest\.spec\.ts/);
  assert.doesNotMatch(grounded, /Prior iteration/);

  const ungrounded = buildCodePhasePrompt({
    instructionText: "fix the bug",
    iterationNumber: 1,
    discoveryContext: null,
    discoveryUnavailableReason: "blocked",
    existingTestPaths: [],
    priorIteration: null,
  });
  assert.match(ungrounded, /NOT available/);
  assert.match(ungrounded, /blocked/);
  assert.doesNotMatch(ungrounded, /localhost/i, "must never fabricate a placeholder site when grounding is unavailable");

  const repair = buildCodePhasePrompt({
    instructionText: "generate a test",
    iterationNumber: 2,
    discoveryContext: null,
    discoveryUnavailableReason: "no-base-url",
    existingTestPaths: [],
    priorIteration: { iterationNumber: 1, summary: "wrote a bad selector", testOutput: "TimeoutError: .foo not found", filesChanged: ["tests/a.spec.ts"] },
  });
  assert.match(repair, /Prior iteration 1 result/);
  assert.match(repair, /TimeoutError: \.foo not found/);
  assert.match(repair, /tests\/a\.spec\.ts/);

  // No live site = a repository task: stated as such, never framed as a missing prerequisite.
  assert.match(repair, /No live site is associated with this run: it is a repository task/);
  assert.doesNotMatch(repair, /live grounding was not attempted/);
});

test("listRepoTestFiles finds test files, skips node_modules/.git, and respects maxFiles/maxDepth", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tm-list-repo-tests-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }).catch(() => {}));

  await fs.mkdir(path.join(root, "tests"), { recursive: true });
  await fs.mkdir(path.join(root, "node_modules", "pkg"), { recursive: true });
  await fs.mkdir(path.join(root, ".git"), { recursive: true });
  await fs.writeFile(path.join(root, "tests", "login.spec.ts"), "");
  await fs.writeFile(path.join(root, "tests", "signup.test.ts"), "");
  await fs.writeFile(path.join(root, "tests", "helper.ts"), ""); // not a test file
  await fs.writeFile(path.join(root, "node_modules", "pkg", "x.test.js"), "");
  await fs.writeFile(path.join(root, ".git", "y.test.js"), "");

  const found = listRepoTestFiles(root);
  assert.ok(found.includes("tests/login.spec.ts"));
  assert.ok(found.includes("tests/signup.test.ts"));
  assert.ok(!found.some((p) => p.includes("helper.ts")));
  assert.ok(!found.some((p) => p.includes("node_modules")));
  assert.ok(!found.some((p) => p.includes(".git")));

  const bounded = listRepoTestFiles(root, { maxFiles: 1 });
  assert.equal(bounded.length, 1, "must stop at maxFiles");
});

test("a dependency provisioning failure fails the run closed, removes the worktree, and never reaches discovery or the code phase", async (t) => {
  const ctx = await setupRun({ status: "queued" });
  t.after(ctx.cleanup);

  let resolveDiscoveryCalled = false;
  let codePhaseCalled = false;
  await assert.rejects(
    advanceDevAgentJob(ctx.opJobCtx, fakeReDelay, {
      requestApproval: async () => "approved",
      provisionDependencies: async () => ({ ok: false, error: "pnpm install --frozen-lockfile exited 1: ERR_PNPM_NO_LOCKFILE" }),
      resolveDiscovery: async () => {
        resolveDiscoveryCalled = true;
        return { context: null, unavailableReason: null };
      },
      codePhase: async () => {
        codePhaseCalled = true;
        return { summary: "", filesChanged: [], costUsd: 0 };
      },
    }),
    /Dependency provisioning failed/
  );

  assert.equal(resolveDiscoveryCalled, false, "discovery must never run if dependency provisioning already failed");
  assert.equal(codePhaseCalled, false, "the code phase must never run in a worktree with unprovisioned dependencies");
  const updated = await prisma.devAgentRun.findUnique({ where: { id: ctx.run.id } });
  assert.equal(updated?.status, "failed");
  assert.match(updated?.error ?? "", /Dependency provisioning failed/);
  assert.match(updated?.error ?? "", /ERR_PNPM_NO_LOCKFILE/, "the real underlying error must be surfaced, not swallowed");
  await assert.rejects(fs.stat(updated!.worktreePath!), "the worktree must be torn down when dependency provisioning fails");
});

test("successful dependency provisioning runs exactly once and gates discovery/the code phase proceeding", async (t) => {
  const ctx = await setupRun({ status: "queued" });
  await prisma.devAgentRun.update({ where: { id: ctx.run.id }, data: { testCommand: "true" } });
  t.after(ctx.cleanup);

  let provisionCalls = 0;
  let provisionedWorktreePath = "";
  await advanceDevAgentJob(ctx.opJobCtx, fakeReDelay, {
    requestApproval: async () => "approved",
    provisionDependencies: async (worktreePath) => {
      provisionCalls += 1;
      provisionedWorktreePath = worktreePath;
      return { ok: true, packageManager: null };
    },
    codePhase: async () => ({ summary: "done", filesChanged: [], costUsd: 0 }),
    runTestCommand: async () => ({ passed: true, output: "ok" }),
  });

  assert.equal(provisionCalls, 1);
  const updated = await prisma.devAgentRun.findUnique({ where: { id: ctx.run.id } });
  assert.equal(updated?.status, "succeeded");
  assert.equal(provisionedWorktreePath, updated?.worktreePath);
});

// ── Objective preservation (release blocker) ────────────────────────────────
const BES_INSTRUCTION = "Generate exactly one Playwright test at tests/bes-landing.spec.ts that navigates to the real Bes landing page and asserts the Get Started button is visible.";
const specWith = (selectorText: string) =>
  `import { test, expect } from '@playwright/test';\ntest('Get Started button is visible on Bes landing page', async ({ page }) => {\n  await page.goto('https://www.bes-app.com');\n  const getStartedButton = page.locator('button:has-text("${selectorText}")');\n  await expect(getStartedButton).toBeVisible();\n});\n`;
const writeSpecPhase = (selectorText: string) => async ({ worktreePath }: { worktreePath: string }) => {
  const content = specWith(selectorText);
  await fs.mkdir(path.join(worktreePath, "tests"), { recursive: true });
  await fs.writeFile(path.join(worktreePath, "tests", "bes-landing.spec.ts"), content);
  return { summary: `assert ${selectorText}`, filesChanged: [{ path: "tests/bes-landing.spec.ts", content }], costUsd: 0 };
};

test("REGRESSION: a failed 'Get Started' test repaired into a passing 'Continue with Email' test ends 'unverified', never 'succeeded'", async (t) => {
  const ctx = await setupRun({ status: "queued" });
  await prisma.devAgentRun.update({ where: { id: ctx.run.id }, data: { testCommand: "npx playwright test", instructionText: BES_INSTRUCTION } });
  t.after(ctx.cleanup);

  // Iteration 1: asserts the requested element; it is not on the page, so the test fails.
  await assert.rejects(
    advanceDevAgentJob(ctx.opJobCtx, fakeReDelay, {
      requestApproval: async () => "approved",
      codePhase: writeSpecPhase("Get Started"),
      runTestCommand: async () => ({ passed: false, output: "1 failed - locator('button:has-text(\"Get Started\")') element(s) not found" }),
    }),
    (e) => e instanceof StopTick
  );

  // Iteration 2: the "repair" swaps the asserted element; the test now really passes.
  let reDelayed = false;
  await advanceDevAgentJob(ctx.opJobCtx, async () => { reDelayed = true; throw new StopTick(null); }, {
    codePhase: writeSpecPhase("Continue with Email"),
    runTestCommand: async () => ({ passed: true, output: "1 passed (4.1s)" }),
  });

  const run = await prisma.devAgentRun.findUnique({ where: { id: ctx.run.id } });
  assert.equal(run?.status, "unverified", "a passing substituted test must never be reported as succeeded");
  assert.match(run?.error ?? "", /objective not verified/);
  assert.match(run?.error ?? "", /Get Started/);
  assert.match(run?.error ?? "", /Continue with Email/);
  assert.equal(reDelayed, false, "must stop, not keep iterating toward another substitute");

  const iters = await prisma.devAgentIteration.findMany({ where: { devAgentRunId: ctx.run.id }, orderBy: { iterationNumber: "asc" } });
  assert.equal(iters.length, 2);
  assert.deepEqual((iters[0].testResult as any).objectiveTargets, [{ text: "Get Started", negated: false }]);
  assert.equal((iters[1].testResult as any).passed, true, "the test really executed and passed - execution alone is not enough");
  assert.equal((iters[1].testResult as any).objective.aligned, false);
});

test("a repair that fixes the selector but keeps the objective is 'succeeded' (execution AND alignment verified)", async (t) => {
  const ctx = await setupRun({ status: "queued" });
  await prisma.devAgentRun.update({ where: { id: ctx.run.id }, data: { testCommand: "npx playwright test", instructionText: BES_INSTRUCTION } });
  t.after(ctx.cleanup);

  await assert.rejects(
    advanceDevAgentJob(ctx.opJobCtx, fakeReDelay, {
      requestApproval: async () => "approved",
      codePhase: writeSpecPhase("Get Started"),
      runTestCommand: async () => ({ passed: false, output: "1 failed - timeout" }),
    }),
    (e) => e instanceof StopTick
  );
  await advanceDevAgentJob(ctx.opJobCtx, fakeReDelay, {
    codePhase: async ({ worktreePath }) => {
      const content = `import { test, expect } from '@playwright/test';\ntest('Get Started button is visible', async ({ page }) => {\n  await page.goto('https://www.bes-app.com', { waitUntil: 'networkidle' });\n  await expect(page.getByRole('button', { name: /get started/i })).toBeVisible({ timeout: 15000 });\n});\n`;
      await fs.writeFile(path.join(worktreePath, "tests", "bes-landing.spec.ts"), content);
      return { summary: "use role locator + longer wait", filesChanged: [{ path: "tests/bes-landing.spec.ts", content }], costUsd: 0 };
    },
    runTestCommand: async () => ({ passed: true, output: "1 passed" }),
  });

  const run = await prisma.devAgentRun.findUnique({ where: { id: ctx.run.id } });
  assert.equal(run?.status, "succeeded", run?.error ?? "");
});

test("when the agent reports the requested element does not exist, the run ends 'unverified' (blocked) without running tests", async (t) => {
  const ctx = await setupRun({ status: "queued" });
  await prisma.devAgentRun.update({ where: { id: ctx.run.id }, data: { testCommand: "npx playwright test", instructionText: BES_INSTRUCTION } });
  t.after(ctx.cleanup);

  let testsRan = false;
  await advanceDevAgentJob(ctx.opJobCtx, fakeReDelay, {
    requestApproval: async () => "approved",
    codePhase: async () => ({ summary: "Blocked: no Get Started button exists", filesChanged: [], costUsd: 0.0001, blocked: "The landing page has no Get Started button" }),
    runTestCommand: async () => { testsRan = true; return { passed: true, output: "" }; },
  });

  const run = await prisma.devAgentRun.findUnique({ where: { id: ctx.run.id } });
  assert.equal(run?.status, "unverified");
  assert.match(run?.error ?? "", /^Blocked/);
  assert.match(run?.error ?? "", /no Get Started button/);
  assert.equal(testsRan, false);
});

// ── B6: code-fix proposals ─────────────────────────────────────────────────
test("code-fix runs record a baseline regression run before any change, without spending an iteration", async (t) => {
  const ctx = await setupRun({ status: "queued", maxIterations: 1 });
  await prisma.devAgentRun.update({ where: { id: ctx.run.id }, data: { testCommand: "node --test", instructionText: "Fix the landing CTA so 'Get Started' is shown again" } });
  t.after(ctx.cleanup);
  const calls: string[] = [];
  const codeFixCtx = { ...ctx.opJobCtx, contextJson: { qeCodeFix: { qeJobId: "qe-1", testCaseId: "tc-1" } } } as any;
  const deps = {
    requestApproval: async () => "approved" as const,
    codePhase: async ({ worktreePath }: { worktreePath: string }) => {
      calls.push("code");
      await fs.writeFile(path.join(worktreePath, "landing.mjs"), "export const cta = 'Get Started';\n");
      return { summary: "Restored CTA", filesChanged: [{ path: "landing.mjs", content: "x" }], costUsd: 0 };
    },
    runTestCommand: async () => { calls.push(calls.includes("code") ? "after" : "baseline"); return { passed: calls.includes("code"), output: calls.includes("code") ? "1 passed" : "expected 'Get Started'" }; },
  };
  await advanceDevAgentJob(codeFixCtx, fakeReDelay, deps);
  assert.deepEqual(calls, ["baseline", "code", "after"], "baseline runs BEFORE any change");
  const iters = await prisma.devAgentIteration.findMany({ where: { devAgentRunId: ctx.run.id }, orderBy: { iterationNumber: "asc" } });
  assert.equal(iters[0].phase, "baseline");
  assert.equal(iters[0].iterationNumber, 0);
  assert.equal((iters[0].testResult as any).passed, false);
  assert.equal(iters[1].iterationNumber, 1, "the baseline does not consume the single allowed iteration");
  assert.equal((await prisma.devAgentRun.findUnique({ where: { id: ctx.run.id } }))?.status, "succeeded");
});

test("ordinary Dev Agent runs get no baseline (behavior unchanged)", async (t) => {
  const ctx = await setupRun({ status: "queued" });
  await prisma.devAgentRun.update({ where: { id: ctx.run.id }, data: { testCommand: "node --test" } });
  t.after(ctx.cleanup);
  let testRuns = 0;
  await advanceDevAgentJob(ctx.opJobCtx, fakeReDelay, {
    requestApproval: async () => "approved",
    codePhase: async () => ({ summary: "x", filesChanged: [{ path: "a.ts", content: "x" }], costUsd: 0 }),
    runTestCommand: async () => { testRuns++; return { passed: true, output: "ok" }; },
  });
  assert.equal(testRuns, 1);
  assert.equal(await prisma.devAgentIteration.count({ where: { devAgentRunId: ctx.run.id, phase: "baseline" } }), 0);
});

test("no Playwright in the repo: a minimal setup is provisioned, disclosed, and the generated spec really executes", async (t) => {
  const ctx = await setupRun({ status: "queued", baseUrl: "http://127.0.0.1:9" });
  t.after(ctx.cleanup);
  let calls = 0;
  let provisionedWith: any = null;
  await advanceDevAgentJob(ctx.opJobCtx, fakeReDelay, {
    requestApproval: async () => "approved",
    resolveDiscovery: async () => ({ context: null, unavailableReason: "crawl-error" }),
    codePhase: async () => ({ summary: "spec", filesChanged: [{ path: "src/a.ts", content: "x" }], costUsd: 0.001 }),
    detectTestCommand: () => (++calls === 1
      ? { command: null, provisionPlaywright: { specs: ["e2e/a.spec.ts"] }, reason: "no Playwright test setup." }
      : { command: "npx --no-install playwright test e2e/a.spec.ts", framework: "playwright", packageManager: "npm", reason: "Playwright via npm" }),
    provisionPlaywright: async (_wt, opts) => { provisionedWith = opts; return { ok: true, dependency: "@playwright/test@1.58.2", files: ["package.json", "package-lock.json", "playwright.config.ts"], output: "ok" }; },
    runTestCommand: async () => ({ passed: true, output: "1 passed" }),
  });
  assert.deepEqual(provisionedWith, { baseUrl: "http://127.0.0.1:9", specs: ["e2e/a.spec.ts"] });
  const run = await prisma.devAgentRun.findUnique({ where: { id: ctx.run.id } });
  assert.equal(run?.status, "succeeded");
  const [it] = await prisma.devAgentIteration.findMany({ where: { devAgentRunId: ctx.run.id } });
  assert.deepEqual((it.testResult as any).provisioned, { dependency: "@playwright/test@1.58.2", files: ["package.json", "package-lock.json", "playwright.config.ts"] });
  assert.match((it.testResult as any).output, /Added minimal Playwright test setup/);
});

test("a failed Playwright provisioning ends 'unverified' with the reason and never executes", async (t) => {
  const ctx = await setupRun({ status: "queued" });
  t.after(ctx.cleanup);
  let ran = false;
  await advanceDevAgentJob(ctx.opJobCtx, fakeReDelay, {
    resolveBaseUrl: async () => "http://127.0.0.1:9",
    requestApproval: async () => "approved",
    codePhase: async () => ({ summary: "spec", filesChanged: [{ path: "src/a.ts", content: "x" }], costUsd: 0.001 }),
    detectTestCommand: () => ({ command: null, provisionPlaywright: { specs: ["e2e/a.spec.ts"] }, reason: "no Playwright test setup." }),
    provisionPlaywright: async () => ({ ok: false, error: "npm install exited 1: registry unreachable" }),
    runTestCommand: async () => { ran = true; return { passed: true, output: "" }; },
  });
  assert.equal(ran, false);
  const run = await prisma.devAgentRun.findUnique({ where: { id: ctx.run.id } });
  assert.equal(run?.status, "unverified");
  assert.match(run?.error ?? "", /Provisioning a Playwright setup failed: npm install exited 1/);
});

test("website-test instruction with no URL uses repository-level generation and source verification", async (t) => {
  const ctx = await setupRun({ status: "queued" });
  t.after(ctx.cleanup);
  await prisma.devAgentRun.update({ where: { id: ctx.run.id }, data: { instructionText: "Write tests that verify the signup page form works" } });
  let approval = false, code = false;
  await advanceDevAgentJob(ctx.opJobCtx, fakeReDelay, {
    resolveBaseUrl: async () => undefined,
    requestApproval: async () => { approval = true; return "approved"; },
    codePhase: async () => { code = true; return { summary: "", filesChanged: [], costUsd: 0 }; },
  });
  const run = await prisma.devAgentRun.findUnique({ where: { id: ctx.run.id } });
  assert.equal(run?.status, "unverified");
  assert.match(run?.error ?? "", /No package\.json or affected test files/);
  assert.equal(approval, true);
  assert.equal(code, true);
  assert.ok(run?.worktreePath, "repository-only verification uses the isolated workspace");
  assert.equal(await prisma.devAgentIteration.count({ where: { devAgentRunId: ctx.run.id } }), 1);
});

test("repository-only tasks proceed without an application URL", async (t) => {
  const ctx = await setupRun({ status: "queued" });
  t.after(ctx.cleanup);
  await prisma.devAgentRun.update({ where: { id: ctx.run.id }, data: { instructionText: "Refactor the date utilities into a single module" } });
  let code = false;
  await advanceDevAgentJob(ctx.opJobCtx, fakeReDelay, {
    resolveBaseUrl: async () => undefined,
    requestApproval: async () => "approved",
    codePhase: async () => { code = true; return { summary: "refactor", filesChanged: [{ path: "src/a.ts", content: "x" }], costUsd: 0 }; },
    detectTestCommand: () => ({ command: null, reason: "No executable test configuration was found." }),
  });
  assert.equal(code, true, "the code phase runs");
  const run = await prisma.devAgentRun.findUnique({ where: { id: ctx.run.id } });
  assert.equal(run?.status, "unverified");
  assert.doesNotMatch(run?.error ?? "", /application URL/);
});

test("generated browser specs with no URL are never provisioned, executed or retried", async (t) => {
  const ctx = await setupRun({ status: "queued" });
  t.after(ctx.cleanup);
  let provisioned = false, ran = false;
  await advanceDevAgentJob(ctx.opJobCtx, fakeReDelay, {
    resolveBaseUrl: async () => undefined,
    requestApproval: async () => "approved",
    codePhase: async () => ({ summary: "spec", filesChanged: [{ path: "e2e/a.spec.ts", content: "x" }], costUsd: 0 }),
    detectTestCommand: () => ({ command: null, provisionPlaywright: { specs: ["e2e/a.spec.ts"] }, reason: "no Playwright test setup." }),
    provisionPlaywright: async () => { provisioned = true; return { ok: true, dependency: "x", files: [], output: "" }; },
    runTestCommand: async () => { ran = true; return { passed: true, output: "" }; },
  });
  assert.equal(provisioned, false);
  assert.equal(ran, false);
  const run = await prisma.devAgentRun.findUnique({ where: { id: ctx.run.id } });
  assert.equal(run?.status, "unverified");
  assert.match(run?.error ?? "", /No authorized application URL/);
});

test("the actual Playwright error is recorded per iteration and shown in the max-iterations failure", async (t) => {
  const ctx = await setupRun({ status: "queued", maxIterations: 1 });
  await prisma.devAgentRun.update({ where: { id: ctx.run.id }, data: { testCommand: "npx playwright test" } });
  t.after(ctx.cleanup);
  const pwOutput = [
    "Running 1 test using 1 worker",
    "  ✘  1 [chromium] › e2e/signup.spec.ts:3:5 › signup works (1.2s)",
    "  1) [chromium] › e2e/signup.spec.ts:3:5 › signup works",
    "    Error: page.goto: Protocol error (Page.navigate): Cannot navigate to invalid URL",
    "    Call log:",
    "      - navigating to \"/\", waiting until \"load\"",
    "  1 failed",
  ].join("\n");
  await assert.rejects(advanceDevAgentJob(ctx.opJobCtx, fakeReDelay, {
    requestApproval: async () => "approved",
    codePhase: async () => ({ summary: "spec", filesChanged: [{ path: "src/a.ts", content: "x" }], costUsd: 0 }),
    runTestCommand: async () => ({ passed: false, output: pwOutput }),
  }), StopTick);
  const [it] = await prisma.devAgentIteration.findMany({ where: { devAgentRunId: ctx.run.id } });
  assert.match((it.testResult as any).failureSummary, /Cannot navigate to invalid URL/);
  await assert.rejects(advanceDevAgentJob(ctx.opJobCtx, fakeReDelay, {}), /Max iterations reached without passing tests\. Last failure \(iteration 1\):[\s\S]*Cannot navigate to invalid URL/);
  const run = await prisma.devAgentRun.findUnique({ where: { id: ctx.run.id } });
  assert.equal(run?.status, "failed");
  assert.match(run?.error ?? "", /Cannot navigate to invalid URL/);
});

const failingSpecOutput = (ms: string) => [
  `  ✘  1 [chromium] › e2e/signup.spec.ts:3:5 › Sign Up page (${ms})`,
  "  1) [chromium] › e2e/signup.spec.ts:3:5 › Sign Up page",
  "    Error: expect(locator).toHaveText(expected) failed",
  "    Locator: locator('h1')",
  '    Expected: "Sign Up"',
  "    Error: element(s) not found",
  "  1 failed",
].join("\n");

test("generated tests are saved to Suites before execution; failing tests after the iteration limit end 'partial', not 'failed'", async (t) => {
  const ctx = await setupRun({ status: "queued", maxIterations: 1 });
  await prisma.devAgentRun.update({ where: { id: ctx.run.id }, data: { testCommand: "npx playwright test" } });
  t.after(ctx.cleanup);
  const suiteFile = path.join(suiteDirForRun({ id: ctx.run.id, projectId: ctx.project.id, requestedBy: "test" }), "e2e/signup.spec.ts");
  let savedBeforeRun = false;
  await assert.rejects(advanceDevAgentJob(ctx.opJobCtx, fakeReDelay, {
    requestApproval: async () => "approved",
    codePhase: async () => ({ summary: "spec", filesChanged: [{ path: "e2e/signup.spec.ts", content: "ORIGINAL" }], costUsd: 0 }),
    runTestCommand: async () => { savedBeforeRun = await fs.readFile(suiteFile, "utf8").then((c) => c.endsWith("ORIGINAL"), () => false); return { passed: false, output: failingSpecOutput("8.2s") }; },
  }), StopTick);
  assert.equal(savedBeforeRun, true, "the spec is in Suites before it is executed");

  await advanceDevAgentJob(ctx.opJobCtx, fakeReDelay, {}); // limit reached: must NOT throw (partial is terminal, not an engine failure)
  const run = await prisma.devAgentRun.findUnique({ where: { id: ctx.run.id } });
  assert.equal(run?.status, "partial");
  assert.match(run?.error ?? "", /saved in Suites[\s\S]*did not pass[\s\S]*0 passed, 1 failed[\s\S]*locator\('h1'\)/);
  assert.match(await fs.readFile(suiteFile, "utf8"), /^\/\/ Generated by TestMind Autonomous Dev[\s\S]*ORIGINAL$/, "the failing test remains saved");
  const [it] = await prisma.devAgentIteration.findMany({ where: { devAgentRunId: ctx.run.id } });
  assert.deepEqual((it.testResult as any).tests, [{ title: "Sign Up page", file: "e2e/signup.spec.ts", status: "failed" }]);
  assert.deepEqual((it.testResult as any).savedSpecs, [`autonomous-dev/${ctx.run.id}/e2e/signup.spec.ts`]);
});

test("a failure identical to the previous iteration stops repairs early (partial with the reason), without using the remaining iterations", async (t) => {
  const ctx = await setupRun({ status: "queued", maxIterations: 5 });
  await prisma.devAgentRun.update({ where: { id: ctx.run.id }, data: { testCommand: "npx playwright test" } });
  t.after(ctx.cleanup);
  let n = 0;
  const deps: Parameters<typeof advanceDevAgentJob>[2] = {
    requestApproval: async () => "approved",
    codePhase: async () => ({ summary: `try ${++n}`, filesChanged: [{ path: "e2e/signup.spec.ts", content: `v${n}` }], costUsd: 0 }),
    runTestCommand: async () => ({ passed: false, output: failingSpecOutput(`${n}.0s`) }),
  };
  await assert.rejects(advanceDevAgentJob(ctx.opJobCtx, fakeReDelay, deps), StopTick);
  await advanceDevAgentJob(ctx.opJobCtx, fakeReDelay, deps); // iteration 2: identical failure -> stop, no re-delay
  const run = await prisma.devAgentRun.findUnique({ where: { id: ctx.run.id } });
  assert.equal(run?.status, "partial");
  assert.match(run?.error ?? "", /same failure repeated in iterations 1 and 2/);
  assert.equal(await prisma.devAgentIteration.count({ where: { devAgentRunId: ctx.run.id } }), 2, "remaining iterations were not spent");
});

test("without any generated tests, failing tests after the limit still fail the run (nothing usable to keep)", async (t) => {
  const ctx = await setupRun({ status: "queued", maxIterations: 1 });
  await prisma.devAgentRun.update({ where: { id: ctx.run.id }, data: { testCommand: "npm test" } });
  t.after(ctx.cleanup);
  await assert.rejects(advanceDevAgentJob(ctx.opJobCtx, fakeReDelay, {
    requestApproval: async () => "approved",
    codePhase: async () => ({ summary: "app change", filesChanged: [{ path: "src/a.ts", content: "x" }], costUsd: 0 }),
    runTestCommand: async () => ({ passed: false, output: "Error: boom" }),
  }), StopTick);
  await assert.rejects(advanceDevAgentJob(ctx.opJobCtx, fakeReDelay, {}), /Max iterations reached/);
  assert.equal((await prisma.devAgentRun.findUnique({ where: { id: ctx.run.id } }))?.status, "failed");
});
