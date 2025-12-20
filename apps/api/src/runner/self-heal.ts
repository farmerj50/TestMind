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
  if (run.trigger === "self-heal") return;
  const headful = Boolean((run.paramsJson as any)?.headful);
  const baseUrl: string | undefined = (run.paramsJson as any)?.baseUrl;

  const failedResults = await prisma.testResult.findMany({
    where: { runId, status: TestResultStatus.failed },
    select: { id: true, testCaseId: true, testCase: { select: { key: true, title: true } } },
  });

  if (!SELF_HEAL_ENABLED || failedResults.length === 0) return;

  let totalAttempts = await prisma.testHealingAttempt.count({
    where: { runId },
  });

  for (const result of failedResults) {
    if (totalAttempts >= MAX_PATCHES_PER_RUN) {
      console.log(
        `[self-heal] run ${runId} reached max patches (${MAX_PATCHES_PER_RUN}); skipping remaining failures`
      );
      break;
    }

    const open = await prisma.testHealingAttempt.findFirst({
      where: {
        testResultId: result.id,
        status: { in: [HealingStatus.queued, HealingStatus.running] },
      },
    });
    if (open) {
      console.log(
        `[self-heal] skipping scheduling for testResult=${result.id} because an attempt is already in-flight`
      );
      continue;
    }

    const attemptsSoFar = await prisma.testHealingAttempt.count({
      where: { testResultId: result.id },
    });

    if (attemptsSoFar >= MAX_ATTEMPTS_PER_SPEC) {
      console.log(
        `[self-heal] skipping testResult=${result.id}; exceeded max attempts (${MAX_ATTEMPTS_PER_SPEC})`
      );
      continue;
    }

    const healingAttempt = await prisma.testHealingAttempt.create({
      data: {
        run: { connect: { id: runId } },
        testResult: { connect: { id: result.id } },
        testCase: { connect: { id: result.testCaseId } },
        attempt: attemptsSoFar + 1,
        status: HealingStatus.queued,
      },
    });
    totalAttempts++;

    await enqueueSelfHeal({
      runId,
      testResultId: result.id,
      testCaseId: result.testCaseId,
      attemptId: healingAttempt.id,
      projectId: run.projectId,
      totalFailed: failedResults.length,
      testTitle: extractTestTitle(result.testCase?.title ?? null),
      headed: headful,
      baseUrl,
    });
  }
}
