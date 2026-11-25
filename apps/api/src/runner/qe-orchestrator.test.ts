import test from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../prisma.js";
import {
  QE_STAGES,
  QeStageError,
  cancelQeRun,
  checkpointOf,
  computeOverallStatus,
  ensureStages,
  finalizeQeRun,
  finishStage,
  getStages,
  pauseQeRun,
  qeContextOf,
  recoverQeRuns,
  requireStageApproval,
  resumeQeRun,
  saveCheckpoint,
  startStage,
  type QeStageKey,
  type StageSnapshot,
} from "./qe-orchestrator.js";

const snap = (o: Partial<Record<QeStageKey, StageSnapshot["outcome"]>>): StageSnapshot[] =>
  QE_STAGES.map((key) => ({ key, outcome: o[key] ?? "pending", reason: o[key] ? `${key} ${o[key]}` : null }));
const ALL_BEFORE_EXEC = { input: "succeeded", discovery: "succeeded", plan: "succeeded", generate: "succeeded" } as const;

async function makeQeJob(status: "queued" | "running" | "paused" = "running", extraCtx: Record<string, unknown> = {}) {
  const project = await prisma.project.findFirst({ orderBy: { createdAt: "asc" } });
  assert.ok(project, "a local test Postgres with at least one Project row is required");
  const job = await prisma.operatorJob.create({
    data: {
      projectId: project!.id, type: "qa", status, requestedBy: "test",
      contextJson: { autonomous: true, baseUrl: "https://example.test", qe: { inputKind: "app_url", input: "https://example.test", baseUrl: "https://example.test" }, ...extraCtx },
    },
  });
  const cleanup = async () => {
    await prisma.operatorArtifact.deleteMany({ where: { jobId: job.id } });
    await prisma.operatorApproval.deleteMany({ where: { jobId: job.id } });
    await prisma.operatorTask.updateMany({ where: { jobId: job.id }, data: { parentTaskId: null } });
    const runIds = (await prisma.operatorTask.findMany({ where: { jobId: job.id, testRunId: { not: null } }, select: { testRunId: true } })).map((t) => t.testRunId!);
    await prisma.operatorTask.deleteMany({ where: { jobId: job.id } });
    if (runIds.length) await prisma.testRun.deleteMany({ where: { id: { in: runIds } } });
    await prisma.operatorJob.delete({ where: { id: job.id } }).catch(() => {});
  };
  return { job, project: project!, cleanup };
}

// ── Truthful overall status ─────────────────────────────────────────────────

test("overall status: succeeded only when every test executed and passed (directly or after verified repair)", () => {
  assert.equal(computeOverallStatus(snap({ ...ALL_BEFORE_EXEC, execute: "succeeded", repair: "skipped", review: "succeeded" })).status, "succeeded");
  assert.equal(computeOverallStatus(snap({ ...ALL_BEFORE_EXEC, execute: "partial", repair: "succeeded", review: "succeeded" })).status, "succeeded");
});

test("overall status: partial when the run completed but failures remain blocked or unrepaired", () => {
  const blocked = computeOverallStatus(snap({ ...ALL_BEFORE_EXEC, execute: "partial", repair: "blocked", review: "succeeded" }));
  assert.equal(blocked.status, "partial");
  assert.match(blocked.reason, /repair/);
  assert.equal(computeOverallStatus(snap({ ...ALL_BEFORE_EXEC, execute: "partial", repair: "partial", review: "succeeded" })).status, "partial");
});

test("overall status: unverified whenever tests never executed or nothing testable was produced", () => {
  assert.equal(computeOverallStatus(snap({ ...ALL_BEFORE_EXEC, execute: "unverified", repair: "skipped", review: "succeeded" })).status, "unverified");
  assert.equal(computeOverallStatus(snap({ input: "succeeded", discovery: "succeeded", plan: "unverified", generate: "skipped", execute: "skipped" })).status, "unverified");
  assert.equal(computeOverallStatus(snap({ input: "succeeded", discovery: "unverified" })).status, "unverified");
  assert.equal(computeOverallStatus(snap({ ...ALL_BEFORE_EXEC })).status, "unverified", "generated but never executed is never success");
});

test("overall status: blocked, failed and canceled keep their meaning and take precedence", () => {
  assert.equal(computeOverallStatus(snap({ input: "succeeded", discovery: "blocked" })).status, "blocked");
  assert.equal(computeOverallStatus(snap({ ...ALL_BEFORE_EXEC, execute: "failed" })).status, "failed");
  assert.equal(computeOverallStatus(snap({ ...ALL_BEFORE_EXEC, execute: "canceled", repair: "canceled" })).status, "canceled");
  assert.equal(computeOverallStatus(snap({ input: "failed" })).status, "failed");
});

test("qeContextOf only recognizes autonomous runs carrying a valid qe context", () => {
  assert.equal(qeContextOf({ autonomous: true }), null, "legacy autonomous QA jobs are untouched");
  assert.equal(qeContextOf({ qe: { inputKind: "page", input: "x" } }), null);
  assert.equal(qeContextOf({ autonomous: true, qe: { inputKind: "nope", input: "x" } }), null);
  assert.ok(qeContextOf({ autonomous: true, qe: { inputKind: "user_story", input: "As a user..." } }));
});

// ── Stage persistence ───────────────────────────────────────────────────────

test("stages are created once, transition explicitly, never reopen, and own the pipeline tasks they produced", async (t) => {
  const { job, cleanup } = await makeQeJob();
  t.after(cleanup);
  await ensureStages(job.id);
  await ensureStages(job.id);
  const stages = await getStages(job.id);
  assert.deepEqual(stages.map((s) => s.stageKey), [...QE_STAGES]);
  assert.ok(stages.every((s) => s.outcome === "pending"));

  assert.equal(await startStage(job.id, "discovery"), true);
  const child = await prisma.operatorTask.create({ data: { jobId: job.id, type: "discover", status: "succeeded" } });
  await finishStage(job.id, "discovery", "succeeded", "3 routes");
  const disc = (await getStages(job.id)).find((s) => s.stageKey === "discovery")!;
  assert.equal(disc.outcome, "succeeded");
  assert.equal(disc.outcomeReason, "3 routes");
  assert.equal((await prisma.operatorTask.findUnique({ where: { id: child.id } }))?.parentTaskId, disc.id);

  assert.equal(await startStage(job.id, "discovery"), false, "a completed stage is never re-run on resume");
  await finishStage(job.id, "discovery", "failed", "late overwrite");
  assert.equal((await getStages(job.id)).find((s) => s.stageKey === "discovery")?.outcome, "succeeded", "terminal outcomes are immutable");
});

test("finalizeQeRun closes unreached stages as skipped and writes the truthful job status", async (t) => {
  const { job, cleanup } = await makeQeJob();
  t.after(cleanup);
  await ensureStages(job.id);
  for (const s of ["input", "discovery", "plan", "generate"] as const) await finishStage(job.id, s, "succeeded", "ok");
  await finishStage(job.id, "execute", "partial", "3/5 passed");
  await startStage(job.id, "repair");
  await finishStage(job.id, "repair", "blocked", "failures need human review");
  const overall = await finalizeQeRun(job.id);
  assert.equal(overall.status, "unverified");
  const after = await prisma.operatorJob.findUnique({ where: { id: job.id } });
  assert.equal(after?.status, "unverified");
  assert.match(after?.error ?? "", /coverage evidence is missing/i);
  const review = (await getStages(job.id)).find((s) => s.stageKey === "review");
  assert.equal(review?.outcome, "skipped");
});

test("finalizeQeRun with an error fails the running stage instead of reporting success", async (t) => {
  const { job, cleanup } = await makeQeJob();
  t.after(cleanup);
  await ensureStages(job.id);
  for (const s of ["input", "discovery", "plan", "generate"] as const) await finishStage(job.id, s, "succeeded", "ok");
  await startStage(job.id, "execute");
  const overall = await finalizeQeRun(job.id, { error: "Autonomous QA timed out waiting for run x" });
  assert.equal(overall.status, "failed");
  assert.equal((await getStages(job.id)).find((s) => s.stageKey === "execute")?.outcome, "failed");
});

test("checkpoints are persisted to the DB on the stage and the job", async (t) => {
  const { job, cleanup } = await makeQeJob();
  t.after(cleanup);
  await ensureStages(job.id);
  await startStage(job.id, "execute");
  const phase = { kind: "autonomous_qa", state: { stage: "wait_initial_run", runId: "r1" } };
  await saveCheckpoint(job.id, "execute", phase);
  const reloaded = await prisma.operatorJob.findUnique({ where: { id: job.id } });
  assert.deepEqual(checkpointOf(reloaded?.contextJson)?.phase, phase);
  assert.equal(checkpointOf(reloaded?.contextJson)?.stage, "execute");
  const stage = (await getStages(job.id)).find((s) => s.stageKey === "execute");
  assert.deepEqual((stage?.checkpointJson as any)?.phase, phase);
});

// ── Approval gate ───────────────────────────────────────────────────────────

test("approval gate: holds the stage until approved, is idempotent, and never blocks routine work", async (t) => {
  const { job, cleanup } = await makeQeJob();
  t.after(cleanup);
  await ensureStages(job.id);
  await startStage(job.id, "execute");
  const gate = { jobId: job.id, stage: "execute" as const, gateKey: "delete-account-case", actionType: "destructive_test" as const, description: "Run a test that deletes an account", requestedBy: "test" };

  const first = await requireStageApproval(gate);
  assert.equal(first.state, "pending");
  assert.equal((await getStages(job.id)).find((s) => s.stageKey === "execute")?.outcome, "awaitingApproval");
  const again = await requireStageApproval(gate);
  assert.equal(again.state, "pending");
  assert.equal(await prisma.operatorApproval.count({ where: { jobId: job.id } }), 1, "re-entering the gate never duplicates the request");

  await prisma.operatorApproval.updateMany({ where: { jobId: job.id }, data: { status: "approved", resolvedBy: "test", resolvedAt: new Date() } });
  assert.equal((await requireStageApproval(gate)).state, "approved");
  assert.equal((await getStages(job.id)).find((s) => s.stageKey === "execute")?.outcome, "running");
});

test("approval gate fails closed on deny and on expiry", async (t) => {
  const { job, cleanup } = await makeQeJob();
  t.after(cleanup);
  await ensureStages(job.id);
  await startStage(job.id, "execute");
  const base = { jobId: job.id, stage: "execute" as const, actionType: "sensitive_action" as const, description: "Submit payment form", requestedBy: "test" };

  await requireStageApproval({ ...base, gateKey: "deny-me" });
  await prisma.operatorApproval.updateMany({ where: { jobId: job.id, status: "pending" }, data: { status: "denied" } });
  await assert.rejects(requireStageApproval({ ...base, gateKey: "deny-me" }), (e) => e instanceof QeStageError && e.outcome === "blocked" && /denied/.test(e.message));

  await requireStageApproval({ ...base, gateKey: "expire-me", timeoutMs: 1 });
  await new Promise((r) => setTimeout(r, 20));
  await assert.rejects(requireStageApproval({ ...base, gateKey: "expire-me" }), (e) => e instanceof QeStageError && e.outcome === "blocked" && /expired/.test(e.message));
  const expired = await prisma.operatorApproval.findFirst({ where: { jobId: job.id, contextJson: { path: ["gateKey"], equals: "expire-me" } } });
  assert.equal(expired?.status, "expired");
});

// ── Controls ────────────────────────────────────────────────────────────────

test("pause/resume transition only from valid states", async (t) => {
  const { job, cleanup } = await makeQeJob("running");
  t.after(cleanup);
  assert.equal(await resumeQeRun(job.id), false, "cannot resume a running run");
  assert.equal(await pauseQeRun(job.id), true);
  assert.equal((await prisma.operatorJob.findUnique({ where: { id: job.id } }))?.status, "paused");
  assert.equal(await pauseQeRun(job.id), false);
  assert.equal(await resumeQeRun(job.id), true);
  assert.equal((await prisma.operatorJob.findUnique({ where: { id: job.id } }))?.status, "running");
});

test("cancel stops the in-flight test run, cancels open stages, and expires pending approvals", async (t) => {
  const { job, project, cleanup } = await makeQeJob("running");
  t.after(cleanup);
  await ensureStages(job.id);
  for (const s of ["input", "discovery", "plan", "generate"] as const) await finishStage(job.id, s, "succeeded", "ok");
  await startStage(job.id, "execute");
  const run = await prisma.testRun.create({ data: { projectId: project.id, status: "running", trigger: "operator" } });
  await prisma.operatorTask.create({ data: { jobId: job.id, type: "execute", status: "running", testRunId: run.id } });
  await requireStageApproval({ jobId: job.id, stage: "execute", gateKey: "g", actionType: "destructive_test", description: "x", requestedBy: "test" });

  const cancelKeys: string[] = [];
  const removed: string[] = [];
  const result = await cancelQeRun(job.id, { setCancelKey: async (id) => { cancelKeys.push(id); }, removeQueuedRun: async (id) => { removed.push(id); } });
  assert.equal(result.canceled, true);
  assert.deepEqual(result.stoppedRunIds, [run.id]);
  assert.deepEqual(cancelKeys, [run.id], "the worker's cancel key must be set so the in-flight Playwright process is aborted");
  assert.deepEqual(removed, [run.id]);
  assert.equal((await prisma.testRun.findUnique({ where: { id: run.id } }))?.status, "failed");
  assert.equal((await prisma.operatorJob.findUnique({ where: { id: job.id } }))?.status, "canceled");
  const stages = await getStages(job.id);
  assert.equal(stages.find((s) => s.stageKey === "input")?.outcome, "succeeded", "completed stages keep their outcome");
  assert.ok(stages.filter((s) => ["execute", "repair", "review"].includes(s.stageKey!)).every((s) => s.outcome === "canceled"));
  assert.equal(await prisma.operatorApproval.count({ where: { jobId: job.id, status: "pending" } }), 0);
  const execTask = await prisma.operatorTask.findFirst({ where: { jobId: job.id, type: "execute" } });
  assert.equal(execTask?.parentTaskId, stages.find((s) => s.stageKey === "execute")?.id, "in-flight steps stay attached to their stage on cancel");
  assert.equal((await cancelQeRun(job.id, { setCancelKey: async () => {}, removeQueuedRun: async () => {} })).canceled, false, "idempotent");
});

// ── Recovery ────────────────────────────────────────────────────────────────

test("recovery re-enqueues lost/failed QE runs from their DB checkpoint and leaves live ones alone", async (t) => {
  const lost = await makeQeJob("running");
  const failed = await makeQeJob("running");
  const live = await makeQeJob("running");
  const legacy = await prisma.operatorJob.create({ data: { projectId: lost.project.id, type: "qa", status: "running", requestedBy: "test", contextJson: { autonomous: true } } });
  t.after(async () => { await lost.cleanup(); await failed.cleanup(); await live.cleanup(); await prisma.operatorJob.delete({ where: { id: legacy.id } }).catch(() => {}); });

  const phase = { kind: "autonomous_qa", state: { stage: "wait_full_verify", runId: "r9" } };
  for (const j of [lost, failed, live]) { await ensureStages(j.job.id); await saveCheckpoint(j.job.id, null, phase); }

  const states: Record<string, string | null> = { [lost.job.id]: null, [failed.job.id]: "failed", [live.job.id]: "delayed", [legacy.id]: null };
  const removed: string[] = [];
  const enqueued: Array<{ id: string; phase: unknown }> = [];
  const recovered = await recoverQeRuns({
    getJobState: async (id) => (id in states ? states[id] : "delayed"),
    removeJob: async (id) => { removed.push(id); },
    enqueue: async (id, p) => { enqueued.push({ id, phase: p }); },
  });
  assert.ok(recovered.includes(lost.job.id));
  assert.ok(recovered.includes(failed.job.id));
  assert.ok(!recovered.includes(live.job.id), "a live delayed job must not be duplicated");
  assert.ok(!recovered.includes(legacy.id), "legacy autonomous QA jobs are out of scope");
  assert.ok(removed.includes(failed.job.id) && !removed.includes(lost.job.id));
  assert.deepEqual(enqueued.find((e) => e.id === lost.job.id)?.phase, phase, "resumes from the saved checkpoint, not from the start");
});
