import type { ScenarioCoverage } from "../lib/qe-coverage.js";
// Autonomous QE orchestration foundation (B1).
//
// An Autonomous QE run IS an existing OperatorJob (type 'qa', context.autonomous = true)
// carrying context.qe. Its pipeline stages are OperatorTask rows (type 'stage') with an
// explicit QeStageOutcome; the existing per-step tasks (discover/execute/triage/repair/
// verify) created by runAutonomousQaJob are attached to their stage via parentTaskId.
// Checkpoints are persisted to the DB (stage row + job context) in addition to BullMQ job
// data, so a restarted worker - or a lost BullMQ job - resumes from the last checkpoint.
//
// Nothing here generates, executes, or repairs tests itself: it records, gates, and
// reports what the existing pipeline does, truthfully.
import { Prisma, type OperatorApprovalAction, type QeStageOutcome } from "@prisma/client";
import { prisma } from "../prisma.js";

export const QE_STAGES = ["input", "discovery", "plan", "generate", "execute", "repair", "review"] as const;
export type QeStageKey = (typeof QE_STAGES)[number];
export const QE_INPUT_KINDS = ["app_url", "page", "user_story", "repository"] as const;
export type QeInputKind = (typeof QE_INPUT_KINDS)[number];

export type QeContext = {
  inputKind: QeInputKind;
  input: string;
  baseUrl?: string;
  planReview?: boolean;
  maxPages?: number;
  targetRepo?: string;
  /** Optional repository access for this run (authorized GitHub integration; never a token). */
  repository?: { url: string; branch?: string };
  repositoryWarning?: string;
};

export type QeRunStatus = "succeeded" | "partial" | "unverified" | "failed" | "canceled" | "blocked";
const TERMINAL_OUTCOMES: QeStageOutcome[] = ["succeeded", "partial", "failed", "unverified", "blocked", "skipped", "canceled"];
export const QE_TERMINAL_JOB_STATUSES = ["succeeded", "failed", "canceled", "partial", "unverified"] as const;

/** Thrown at a known decision point to end the current stage with a specific truthful outcome. */
export class QeStageError extends Error {
  constructor(public readonly stage: QeStageKey, public readonly outcome: QeStageOutcome, message: string) {
    super(message);
    this.name = "QeStageError";
  }
}

export function qeContextOf(contextJson: unknown): QeContext | null {
  const ctx = (contextJson ?? {}) as Record<string, any>;
  const qe = ctx.qe;
  if (ctx.autonomous !== true || !qe || typeof qe !== "object") return null;
  if (!QE_INPUT_KINDS.includes(qe.inputKind) || typeof qe.input !== "string") return null;
  return qe as QeContext;
}

// ── Stage persistence ────────────────────────────────────────────────────────

export async function ensureStages(jobId: string) {
  const existing = await prisma.operatorTask.findMany({ where: { jobId, type: "stage" }, select: { stageKey: true } });
  const have = new Set(existing.map((s) => s.stageKey));
  const missing = QE_STAGES.map((key, i) => ({ key, i })).filter(({ key }) => !have.has(key));
  if (missing.length) {
    await prisma.operatorTask.createMany({
      data: missing.map(({ key, i }) => ({ jobId, type: "stage" as const, status: "pending" as const, stageKey: key, stageOrder: i, outcome: "pending" as const })),
    });
  }
}

export async function getStages(jobId: string) {
  return prisma.operatorTask.findMany({ where: { jobId, type: "stage" }, orderBy: { stageOrder: "asc" } });
}

async function stageRow(jobId: string, key: QeStageKey) {
  const row = await prisma.operatorTask.findFirst({ where: { jobId, type: "stage", stageKey: key } });
  if (!row) throw new Error(`QE stage ${key} missing for job ${jobId}`);
  return row;
}

export async function currentStageKey(jobId: string): Promise<QeStageKey | null> {
  const row = await prisma.operatorTask.findFirst({
    where: { jobId, type: "stage", outcome: { in: ["running", "awaitingApproval"] } },
    orderBy: { stageOrder: "asc" },
    select: { stageKey: true },
  });
  return (row?.stageKey as QeStageKey | undefined) ?? null;
}

export async function stageOutcome(jobId: string, key: QeStageKey): Promise<QeStageOutcome | null> {
  const row = await prisma.operatorTask.findFirst({ where: { jobId, type: "stage", stageKey: key }, select: { outcome: true } });
  return row?.outcome ?? null;
}

/** Marks a stage running. Idempotent: never reopens a stage that already reached a terminal outcome. */
export async function startStage(jobId: string, key: QeStageKey) {
  const row = await stageRow(jobId, key);
  if (row.outcome && TERMINAL_OUTCOMES.includes(row.outcome)) return false;
  await prisma.operatorTask.update({
    where: { id: row.id },
    data: { outcome: "running", status: "running", startedAt: row.startedAt ?? new Date(), outcomeReason: null },
  });
  return true;
}

function taskStatusFor(outcome: QeStageOutcome) {
  if (outcome === "succeeded") return "succeeded" as const;
  if (outcome === "skipped" || outcome === "canceled") return "skipped" as const;
  if (outcome === "pending") return "pending" as const;
  if (outcome === "running" || outcome === "awaitingApproval") return "running" as const;
  return "failed" as const;
}

/** Ends a stage with an explicit outcome and attaches the existing pipeline tasks it produced. */
export async function finishStage(jobId: string, key: QeStageKey, outcome: QeStageOutcome, reason: string, output?: Record<string, unknown>) {
  const row = await stageRow(jobId, key);
  if (row.outcome && TERMINAL_OUTCOMES.includes(row.outcome)) return;
  const now = new Date();
  await prisma.operatorTask.update({
    where: { id: row.id },
    data: {
      outcome,
      status: taskStatusFor(outcome),
      outcomeReason: reason,
      startedAt: row.startedAt ?? now,
      finishedAt: now,
      ...(output ? { outputJson: output as Prisma.InputJsonValue } : {}),
    },
  });
  await attachChildTasks(jobId, row.id, row.startedAt ?? now);
}

async function attachChildTasks(jobId: string, stageTaskId: string, since: Date) {
  await prisma.operatorTask.updateMany({
    where: { jobId, parentTaskId: null, type: { not: "stage" }, createdAt: { gte: since } },
    data: { parentTaskId: stageTaskId },
  });
}

export async function setStageAwaitingApproval(jobId: string, key: QeStageKey, reason: string) {
  const row = await stageRow(jobId, key);
  await prisma.operatorTask.update({ where: { id: row.id }, data: { outcome: "awaitingApproval", status: "running", outcomeReason: reason } });
}

/** Persists the resume checkpoint on the stage row and the job (authoritative for recovery). */
export async function saveCheckpoint(jobId: string, key: QeStageKey | null, phase: unknown) {
  const savedAt = new Date().toISOString();
  if (key) {
    const row = await stageRow(jobId, key);
    await prisma.operatorTask.update({ where: { id: row.id }, data: { checkpointJson: { phase, savedAt } as Prisma.InputJsonValue } });
  }
  const job = await prisma.operatorJob.findUnique({ where: { id: jobId }, select: { contextJson: true } });
  const ctx = (job?.contextJson ?? {}) as Record<string, any>;
  await prisma.operatorJob.update({
    where: { id: jobId },
    data: { contextJson: { ...ctx, _qeCheckpoint: { stage: key, phase, savedAt } } as Prisma.InputJsonValue },
  });
}

export function checkpointOf(contextJson: unknown): { stage: QeStageKey | null; phase: any; savedAt: string } | null {
  const cp = (contextJson as any)?._qeCheckpoint;
  return cp && typeof cp === "object" ? cp : null;
}

// ── Truthful overall status ─────────────────────────────────────────────────

export type StageSnapshot = { key: QeStageKey; outcome: QeStageOutcome | null; reason?: string | null };

/**
 * succeeded  - every required stage succeeded: tests were generated, ALL executed, ALL passed.
 * partial    - the run completed, but some tests failed or were blocked / not repaired.
 * unverified - tests never executed, or nothing testable/verifiable was produced.
 * failed / canceled / blocked keep their usual meaning.
 */
export function computeOverallStatus(stages: StageSnapshot[], coverage?: ScenarioCoverage | null): { status: QeRunStatus; reason: string } {
  const by = new Map(stages.map((s) => [s.key, s]));
  const o = (k: QeStageKey) => by.get(k)?.outcome ?? null;
  const why = (k: QeStageKey) => `${k}: ${by.get(k)?.reason ?? o(k) ?? "not reached"}`;

  const canceled = stages.find((s) => s.outcome === "canceled");
  if (canceled) return { status: "canceled", reason: `Canceled during ${canceled.key}` };
  const failed = stages.find((s) => s.outcome === "failed");
  if (failed) return { status: "failed", reason: why(failed.key) };
  for (const k of ["input", "discovery", "plan", "generate"] as const) {
    if (o(k) === "blocked") return { status: "blocked", reason: why(k) };
    if (o(k) === "unverified") return { status: "unverified", reason: why(k) };
  }
  for (const k of ["input", "discovery", "plan", "generate"] as const) {
    if (o(k) !== "succeeded") return { status: "unverified", reason: `${k} did not complete (${o(k) ?? "not reached"}); no tests were verified` };
  }
  const exec = o("execute");
  if (exec === "unverified" || exec === null || exec === "pending" || exec === "skipped") {
    return { status: "unverified", reason: why("execute") };
  }
  if (coverage !== undefined && !coverage?.complete) {
    const passed = coverage?.counts.passed ?? 0;
    return { status: passed ? "partial" : "unverified", reason: coverage ? `Verified ${passed}/${coverage.total} planned scenarios; ${coverage.counts.blocked} blocked, ${coverage.counts.unimplemented} unimplemented, ${coverage.counts.failed} failed` : "Scenario coverage evidence is missing" };
  }
  if (exec === "succeeded") {
    if (o("repair") === "skipped" || o("repair") === null || o("repair") === "pending") return { status: "succeeded", reason: "All generated tests executed and passed" };
  }
  const rep = o("repair");
  if (exec === "partial" || exec === "blocked") {
    if (rep === "succeeded") return { status: "succeeded", reason: "Failures were repaired and the full suite re-verified passing" };
    return { status: "partial", reason: rep && rep !== "skipped" && rep !== "pending" ? why("repair") : why("execute") };
  }
  if (rep === "partial" || rep === "blocked") return { status: "partial", reason: why("repair") };
  return { status: "unverified", reason: `Unexpected stage combination (execute=${exec}, repair=${rep})` };
}

/** Closes any unfinished stage and writes the run's truthful terminal status. */
export async function finalizeQeRun(jobId: string, opts: { error?: string } = {}) {
  const stages = await getStages(jobId);
  const cur = stages.find((s) => s.outcome === "running" || s.outcome === "awaitingApproval");
  if (cur && opts.error) await finishStage(jobId, cur.stageKey as QeStageKey, "failed", opts.error);
  const after = await getStages(jobId);
  const stoppedAt = after.find((s) => s.outcome && TERMINAL_OUTCOMES.includes(s.outcome) && s.outcome !== "succeeded" && s.outcome !== "skipped");
  for (const s of after) {
    if (s.outcome === "pending" || s.outcome === null || s.outcome === "running" || s.outcome === "awaitingApproval") {
      await finishStage(jobId, s.stageKey as QeStageKey, "skipped", stoppedAt ? `Not reached: ${stoppedAt.stageKey} ended ${stoppedAt.outcome}` : "Not reached");
    }
  }
  const final = await getStages(jobId);
  const evidence = await prisma.operatorArtifact.findMany({ where: { jobId, type: { in: ["execution_result", "report"] } }, orderBy: { createdAt: "desc" }, select: { metaJson: true } });
  const coverage = evidence.map((a) => (a.metaJson as any)?.coverage).find((c) => c?.scenarios) as ScenarioCoverage | undefined;
  const overall = computeOverallStatus(final.map((s) => ({ key: s.stageKey as QeStageKey, outcome: s.outcome, reason: s.outcomeReason })), coverage ?? null);
  await prisma.operatorJob.updateMany({
    where: { id: jobId, status: { not: "canceled" } },
    data: { status: overall.status === "blocked" ? "blocked" : overall.status, finishedAt: new Date(), error: overall.status === "succeeded" ? null : overall.reason },
  });
  // Credentials supplied for this run only are deleted as soon as the run ends.
  await import("../lib/qe-run-access.js").then((m) => m.releaseRunCredentials(jobId)).catch(() => {});
  return overall;
}

// ── Artifacts ────────────────────────────────────────────────────────────────

export async function recordQeArtifact(opts: {
  jobId: string;
  stage: QeStageKey;
  type: "plan" | "spec" | "execution_result" | "repair_attempt" | "pr_proposal" | "report";
  path: string;
  testRunId?: string;
  meta?: Record<string, unknown>;
}) {
  const row = await stageRow(opts.jobId, opts.stage);
  return prisma.operatorArtifact.create({
    data: { jobId: opts.jobId, taskId: row.id, testRunId: opts.testRunId ?? null, type: opts.type, path: opts.path, metaJson: { stage: opts.stage, ...(opts.meta ?? {}) } as Prisma.InputJsonValue },
  });
}

// ── Approval gate (non-blocking, checkpointed) ───────────────────────────────

export type GateResult = { state: "approved" } | { state: "pending"; approvalId: string };

/**
 * Explicit approval for destructive tests, sensitive actions, source-code changes, and PR
 * publication. Never holds the worker thread: returns 'pending' (caller re-delays with its
 * checkpoint and re-enters), 'approved' once granted, and throws QeStageError('blocked')
 * when denied or expired - failing closed.
 */
export async function requireStageApproval(opts: {
  jobId: string;
  stage: QeStageKey;
  gateKey: string;
  actionType: OperatorApprovalAction;
  description: string;
  requestedBy: string;
  timeoutMs?: number;
  context?: Record<string, unknown>;
}): Promise<GateResult> {
  const row = await stageRow(opts.jobId, opts.stage);
  const existing = await prisma.operatorApproval.findFirst({
    where: { jobId: opts.jobId, taskId: row.id, actionType: opts.actionType, contextJson: { path: ["gateKey"], equals: opts.gateKey } },
    orderBy: { requestedAt: "desc" },
  });

  if (!existing) {
    const approval = await prisma.operatorApproval.create({
      data: {
        jobId: opts.jobId,
        taskId: row.id,
        actionType: opts.actionType,
        requestedBy: opts.requestedBy,
        expiresAt: new Date(Date.now() + (opts.timeoutMs ?? 30 * 60 * 1000)),
        contextJson: { gateKey: opts.gateKey, prompt: opts.description, ...(opts.context ?? {}) } as Prisma.InputJsonValue,
      },
    });
    await setStageAwaitingApproval(opts.jobId, opts.stage, `Awaiting approval: ${opts.description}`);
    return { state: "pending", approvalId: approval.id };
  }

  if (existing.status === "approved") {
    await prisma.operatorTask.update({ where: { id: row.id }, data: { outcome: "running", status: "running", outcomeReason: null } });
    return { state: "approved" };
  }
  if (existing.status === "denied") throw new QeStageError(opts.stage, "blocked", `Approval denied: ${opts.description}`);
  if (existing.status === "expired" || (existing.expiresAt && existing.expiresAt.getTime() < Date.now())) {
    await prisma.operatorApproval.updateMany({ where: { id: existing.id, status: "pending" }, data: { status: "expired" } });
    throw new QeStageError(opts.stage, "blocked", `Approval expired: ${opts.description}`);
  }
  return { state: "pending", approvalId: existing.id };
}

// ── Controls ─────────────────────────────────────────────────────────────────

export async function pauseQeRun(jobId: string) {
  const r = await prisma.operatorJob.updateMany({ where: { id: jobId, status: { in: ["queued", "running", "blocked"] } }, data: { status: "paused" } });
  return r.count > 0;
}

export async function resumeQeRun(jobId: string) {
  const r = await prisma.operatorJob.updateMany({ where: { id: jobId, status: "paused" }, data: { status: "running" } });
  return r.count > 0;
}

/**
 * Cancels the run, actually stops any in-flight test run (same mechanism as
 * POST /test-runs/:id/stop: redis cancel key the worker polls + queued job removal), and
 * expires pending approvals so nothing can resume it.
 */
export async function cancelQeRun(jobId: string, deps: {
  setCancelKey: (runId: string) => Promise<void>;
  removeQueuedRun: (runId: string) => Promise<void>;
}) {
  const r = await prisma.operatorJob.updateMany({
    where: { id: jobId, status: { notIn: [...QE_TERMINAL_JOB_STATUSES] } },
    data: { status: "canceled", finishedAt: new Date(), error: "Canceled by user" },
  });
  if (!r.count) return { canceled: false, stoppedRunIds: [] as string[] };

  const tasks = await prisma.operatorTask.findMany({ where: { jobId, testRunId: { not: null } }, select: { testRunId: true } });
  const runIds = [...new Set(tasks.map((t) => t.testRunId!))];
  const active = await prisma.testRun.findMany({ where: { id: { in: runIds }, status: { in: ["queued", "running"] } }, select: { id: true } });
  for (const run of active) {
    await deps.setCancelKey(run.id).catch(() => {});
    await deps.removeQueuedRun(run.id).catch(() => {});
    await prisma.testRun.updateMany({
      where: { id: run.id, status: { in: ["queued", "running"] } },
      data: { status: "failed", finishedAt: new Date(), error: "Canceled by user (Autonomous QE run canceled)" },
    });
  }
  await prisma.operatorApproval.updateMany({ where: { jobId, status: "pending" }, data: { status: "expired", resolvedAt: new Date() } });
  await import("../lib/qe-run-access.js").then((m) => m.releaseRunCredentials(jobId)).catch(() => {});
  await prisma.operatorTask.updateMany({ where: { jobId, type: { not: "stage" }, status: { in: ["pending", "running"] } }, data: { status: "skipped", finishedAt: new Date(), error: "Canceled" } });

  const stages = await getStages(jobId);
  for (const s of stages) {
    if (s.outcome && TERMINAL_OUTCOMES.includes(s.outcome)) continue;
    if (s.startedAt) await attachChildTasks(jobId, s.id, s.startedAt);
    await prisma.operatorTask.update({
      where: { id: s.id },
      data: { outcome: "canceled", status: "skipped", outcomeReason: "Run canceled by user", finishedAt: new Date(), startedAt: s.startedAt ?? undefined },
    });
  }
  return { canceled: true, stoppedRunIds: active.map((a) => a.id) };
}

// ── Recovery ─────────────────────────────────────────────────────────────────

/**
 * Re-enqueues in-flight QE runs whose BullMQ job was lost or failed (e.g. stalled past the
 * limit across a worker restart), resuming from the DB checkpoint so completed stages are
 * never repeated. Runs with a live (waiting/delayed/active) BullMQ job are left alone.
 */
export async function recoverQeRuns(deps: {
  getJobState: (jobId: string) => Promise<string | null>;
  removeJob: (jobId: string) => Promise<void>;
  enqueue: (jobId: string, resumePhase?: unknown) => Promise<void>;
}) {
  const candidates = await prisma.operatorJob.findMany({
    where: { type: "qa", status: { in: ["queued", "running", "paused", "blocked"] }, contextJson: { path: ["autonomous"], equals: true } },
    select: { id: true, contextJson: true },
  });
  const recovered: string[] = [];
  for (const job of candidates) {
    if (!qeContextOf(job.contextJson)) continue;
    const state = await deps.getJobState(job.id);
    if (state && ["waiting", "delayed", "active", "prioritized", "waiting-children"].includes(state)) continue;
    if (state) await deps.removeJob(job.id);
    const cp = checkpointOf(job.contextJson);
    await deps.enqueue(job.id, cp?.phase ?? undefined);
    recovered.push(job.id);
  }
  return recovered;
}
