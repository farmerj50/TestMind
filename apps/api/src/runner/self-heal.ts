import { prisma } from '../prisma';
import { enqueueSelfHeal } from './queue';
import { extractTestTitle } from './test-title';

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

/**
 * Schedule self-healing attempts for each failed test result in the run.
 * The actual healing work is handled by the self-heal worker.
 */
export async function scheduleSelfHealingForRun(runId: string) {
  const run = await prisma.testRun.findUnique({
    where: { id: runId },
    select: { projectId: true, paramsJson: true, trigger: true },
  });
  if (!run) return;
  const headful = Boolean((run.paramsJson as any)?.headful);
  const baseUrl: string | undefined = (run.paramsJson as any)?.baseUrl;

  if (!SELF_HEAL_ENABLED) return;

  const inflight = await prisma.testHealingAttempt.findFirst({
    where: {
      runId,
      status: { in: [HealingStatus.queued, HealingStatus.running] },
    },
    select: { id: true },
  });
  if (inflight) {
    console.log(`[self-heal] run ${runId} already has an in-flight attempt; skipping schedule`);
    return;
  }

  const failedResultsCount = await prisma.testResult.count({
    where: { runId, status: TestResultStatus.failed },
  });
  if (failedResultsCount === 0) return;

  let totalAttempts = await prisma.testHealingAttempt.count({ where: { runId } });
  if (totalAttempts >= MAX_PATCHES_PER_RUN) {
    console.log(
      `[self-heal] run ${runId} reached max patches (${MAX_PATCHES_PER_RUN}); skipping healing`
    );
    return;
  }

  const nextFailure = await prisma.testResult.findFirst({
    where: { runId, status: TestResultStatus.failed },
    orderBy: { id: "asc" },
    select: { id: true, testCaseId: true, testCase: { select: { title: true } } },
  });
  if (!nextFailure) return;

  const attemptsSoFar = await prisma.testHealingAttempt.count({
    where: { testResultId: nextFailure.id },
  });
  if (attemptsSoFar >= MAX_ATTEMPTS_PER_SPEC) {
    console.log(
      `[self-heal] skipping testResult=${nextFailure.id}; exceeded max attempts (${MAX_ATTEMPTS_PER_SPEC})`
    );
    return;
  }

  const healingAttempt = await prisma.testHealingAttempt.create({
    data: {
      run: { connect: { id: runId } },
      testResult: { connect: { id: nextFailure.id } },
      testCase: { connect: { id: nextFailure.testCaseId } },
      attempt: attemptsSoFar + 1,
      status: HealingStatus.queued,
    },
  });

  await enqueueSelfHeal({
    runId,
    testResultId: nextFailure.id,
    testCaseId: nextFailure.testCaseId,
    attemptId: healingAttempt.id,
    projectId: run.projectId,
    totalFailed: failedResultsCount,
    testTitle: extractTestTitle(nextFailure.testCase?.title ?? null),
    headed: headful,
    baseUrl,
  });
}
