import { prisma } from '../prisma';
import { enqueueSelfHeal } from './queue';
const TestResultStatus = {
  passed: "passed",
  failed: "failed",
  skipped: "skipped",
  error: "error",
} as const;

/**
 * Schedule self-healing attempts for each failed test result in the run.
 * The actual healing work is handled by the self-heal worker.
 */
export async function scheduleSelfHealingForRun(runId: string) {
  const run = await prisma.testRun.findUnique({
    where: { id: runId },
    select: { projectId: true, paramsJson: true },
  });
  if (!run) return;
  const headful = Boolean((run.paramsJson as any)?.headful);
  const baseUrl: string | undefined = (run.paramsJson as any)?.baseUrl;

  const failedResults = await prisma.testResult.findMany({
    where: { runId, status: TestResultStatus.failed },
    select: { id: true, testCaseId: true, testCase: { select: { key: true, title: true } } },
  });

  if (failedResults.length === 0) return;

  for (const result of failedResults) {
    const attemptsSoFar = await prisma.testHealingAttempt.count({
      where: { testResultId: result.id },
    });

    const healingAttempt = await prisma.testHealingAttempt.create({
      data: {
        run: { connect: { id: runId } },
        testResult: { connect: { id: result.id } },
        testCase: { connect: { id: result.testCaseId } },
        attempt: attemptsSoFar + 1,
      },
    });

      await enqueueSelfHeal({
        runId,
        testResultId: result.id,
        testCaseId: result.testCaseId,
        attemptId: healingAttempt.id,
        projectId: run.projectId,
        totalFailed: failedResults.length,
        testTitle: result.testCase?.title ?? null,
        headed: headful,
        baseUrl,
      });
  }
}
