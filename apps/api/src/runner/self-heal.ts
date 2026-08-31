import { prisma } from '../prisma.js';
import { enqueueSelfHeal } from './queue.js';
import { extractTestTitle } from './test-title.js';

const TestResultStatus = {
  passed: "passed",
  failed: "failed",
  skipped: "skipped",
  error: "error",
} as const;

const HealingStatus = {
  queued: "queued",
  running: "running",
  succeeded: "succeeded",
  failed: "failed",
} as const;

const MAX_ATTEMPTS_PER_SPEC = (() => {
  const raw = Number(process.env.SELF_HEAL_MAX_ATTEMPTS_PER_SPEC ?? "3");
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : Infinity;
})();

const MAX_PATCHES_PER_RUN = (() => {
  const raw = Number(process.env.SELF_HEAL_MAX_PATCHES_PER_RUN ?? "10");
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : Infinity;
})();

const SELF_HEAL_ENABLED = (process.env.SELF_HEAL_ENABLED ?? "1") !== "0";

type QueueHealResult =
  | { status: "queued"; attemptId: string }
  | { status: "blocked"; reason: string; attemptId?: string };

async function queueHealingAttemptForTarget(input: {
  runId: string;
  testResultId: string;
  testCaseId: string;
  testTitle?: string | null;
}): Promise<QueueHealResult> {
  const run = await prisma.testRun.findUnique({
    where: { id: input.runId },
    select: { projectId: true, paramsJson: true, trigger: true },
  });
  if (!run) return { status: "blocked", reason: "run_not_found" };
  const headful = Boolean((run.paramsJson as any)?.headful);
  const baseUrl: string | undefined = (run.paramsJson as any)?.baseUrl;
  const adapterId: string | undefined =
    typeof (run.paramsJson as any)?.adapterId === "string"
      ? (run.paramsJson as any).adapterId
      : undefined;

  if (!SELF_HEAL_ENABLED) return { status: "blocked", reason: "self_heal_disabled" };

  const inflight = await prisma.testHealingAttempt.findFirst({
    where: {
      runId: input.runId,
      status: { in: [HealingStatus.queued, HealingStatus.running] },
    },
    select: { id: true },
  });
  if (inflight) {
    console.log(`[self-heal] run ${input.runId} already has an in-flight attempt; skipping schedule`);
    return { status: "blocked", reason: "self_heal_inflight", attemptId: inflight.id };
  }

  const failedResultsCount = await prisma.testResult.count({
    where: { runId: input.runId, status: TestResultStatus.failed },
  });
  if (failedResultsCount === 0) return { status: "blocked", reason: "no_failed_results" };

  const totalAttempts = await prisma.testHealingAttempt.count({ where: { runId: input.runId } });
  if (totalAttempts >= MAX_PATCHES_PER_RUN) {
    console.log(
      `[self-heal] run ${input.runId} reached max patches (${MAX_PATCHES_PER_RUN}); skipping healing`
    );
    return { status: "blocked", reason: "max_patches_per_run" };
  }

  const targetFailure = await prisma.testResult.findFirst({
    where: {
      id: input.testResultId,
      runId: input.runId,
      testCaseId: input.testCaseId,
      status: TestResultStatus.failed,
    },
    select: { id: true, testCaseId: true, testCase: { select: { key: true, title: true } } },
  });
  if (!targetFailure) return { status: "blocked", reason: "target_not_failed" };

  // Skip synthetic "no report" failures — their spec key starts with "unknown#" and
  // there is no real spec file to heal. Attempting repair triggers an unresolvable loop.
  const caseKey = targetFailure.testCase?.key ?? "";
  if (!caseKey || caseKey.startsWith("unknown#") || caseKey.startsWith("unknown ")) {
    console.log(`[self-heal] skipping synthetic failure testResult=${targetFailure.id} (key="${caseKey}")`);
    return { status: "blocked", reason: "synthetic_failure" };
  }

  // Scoped by testCaseId, not testResultId: every rerun creates a brand-new TestResult row,
  // so a testResultId-scoped count always reads back as 0 for a fresh rerun and this cap
  // never actually engages across a rerun chain - confirmed live (a single test case ran
  // ~30 healing attempts across ~20 minutes before this fix, each one a real LLM call,
  // because each rerun's new TestResult reset the per-attempt counter to zero).
  const attemptsSoFar = await prisma.testHealingAttempt.count({
    where: { testCaseId: targetFailure.testCaseId },
  });
  if (attemptsSoFar >= MAX_ATTEMPTS_PER_SPEC) {
    console.log(
      `[self-heal] skipping testCase=${targetFailure.testCaseId} (testResult=${targetFailure.id}); exceeded max attempts across rerun chain (${MAX_ATTEMPTS_PER_SPEC})`
    );
    return { status: "blocked", reason: "max_attempts_per_spec" };
  }

  const healingAttempt = await prisma.testHealingAttempt.create({
    data: {
      run: { connect: { id: input.runId } },
      testResult: { connect: { id: targetFailure.id } },
      testCase: { connect: { id: targetFailure.testCaseId } },
      attempt: attemptsSoFar + 1,
      status: HealingStatus.queued,
    },
  });

  await enqueueSelfHeal({
    runId: input.runId,
    testResultId: targetFailure.id,
    testCaseId: targetFailure.testCaseId,
    attemptId: healingAttempt.id,
    projectId: run.projectId,
    adapterId,
    totalFailed: failedResultsCount,
    testTitle: extractTestTitle(input.testTitle ?? targetFailure.testCase?.title ?? null),
    headed: headful,
    baseUrl,
  });

  return { status: "queued", attemptId: healingAttempt.id };
}

/**
 * Schedule self-healing attempts for each failed test result in the run.
 * The actual healing work is handled by the self-heal worker.
 */
// Reasons queueHealingAttemptForTarget can return that apply to the whole run, not just the
// one target that was tried - retrying a different failing test in the same run would hit
// the identical block, so there's no point continuing the loop below for these.
const RUN_WIDE_BLOCK_REASONS = new Set([
  "self_heal_disabled",
  "self_heal_inflight",
  "no_failed_results",
  "max_patches_per_run",
  "run_not_found",
]);

export async function scheduleSelfHealingForRun(runId: string) {
  // Try every failing test in the run, not just the first by id - a run can have several
  // distinct failures, and the first one alone may be blocked (e.g. it already exhausted
  // MAX_ATTEMPTS_PER_SPEC) while a different failure in the same run has never been
  // attempted. Stops at the first successfully queued attempt (only one heal runs at a
  // time per run - queueHealingAttemptForTarget's own in-flight check enforces that) or at
  // the first run-wide block, whichever comes first.
  const failures = await prisma.testResult.findMany({
    where: { runId, status: TestResultStatus.failed },
    orderBy: { id: "asc" },
    select: { id: true, testCaseId: true, testCase: { select: { title: true } } },
  });

  for (const failure of failures) {
    const result = await queueHealingAttemptForTarget({
      runId,
      testResultId: failure.id,
      testCaseId: failure.testCaseId,
      testTitle: failure.testCase?.title ?? null,
    });
    if (result.status === "queued") return result;
    if (RUN_WIDE_BLOCK_REASONS.has(result.reason)) return result;
    // Per-test block (e.g. max_attempts_per_spec, synthetic_failure, target_not_failed) -
    // move on and try the next failing test in this run instead of giving up entirely.
  }
}

export async function scheduleSelfHealingForTarget(input: {
  runId: string;
  testResultId: string;
  testCaseId: string;
  testTitle?: string | null;
}) {
  return queueHealingAttemptForTarget(input);
}
