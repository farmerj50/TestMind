import { prisma } from "../prisma.js";

type FinalizeInput = {
  runId: string;
  source?: "run" | "self-heal-rerun" | "qa-verify";
};

/**
 * Journey 1 & 2: After any run completes, write a canonical "latest execution"
 * snapshot onto each TestCase touched by that run.
 *
 * This is the single place that makes healed-pass state canonical across
 * TestCase, dashboard aggregates, and history. Every other surface reads
 * lastResultStatus / lastHealedAt from here instead of inferring from history.
 */
export async function finalizeLatestTestState(input: FinalizeInput) {
  const { runId, source = "run" } = input;

  const run = await prisma.testRun.findUnique({
    where: { id: runId },
    select: {
      id: true,
      trigger: true,
      rerunOfId: true,
      createdAt: true,
      startedAt: true,
      finishedAt: true,
      results: {
        select: {
          id: true,
          status: true,
          message: true,
          testCaseId: true,
        },
      },
    },
  });

  if (!run || run.results.length === 0) return;

  const runAt = run.finishedAt ?? run.startedAt ?? run.createdAt;
  const isSelfHealRerun = run.trigger === "self-heal";

  for (const result of run.results) {
    const isFailure = result.status === "failed" || result.status === "error";

    const update: {
      lastResultStatus: (typeof result)["status"];
      lastRunId: string;
      lastRunAt: Date;
      lastFailureMessage: string | null;
      lastSource: string;
      lastHealedAt?: Date | null;
      lastHealingAttemptId?: string | null;
    } = {
      lastResultStatus: result.status,
      lastRunId: run.id,
      lastRunAt: runAt,
      lastFailureMessage: isFailure ? (result.message ?? null) : null,
      lastSource: source,
    };

    // If this is a self-heal rerun and the test passed, link the healing attempt.
    if (isSelfHealRerun && result.status === "passed") {
      const latestHeal = await prisma.testHealingAttempt.findFirst({
        where: {
          testCaseId: result.testCaseId,
          runId: run.rerunOfId ?? undefined,
        },
        orderBy: { updatedAt: "desc" },
        select: { id: true, updatedAt: true },
      });

      update.lastHealedAt = latestHeal?.updatedAt ?? new Date();
      update.lastHealingAttemptId = latestHeal?.id ?? null;
      update.lastSource = "self-heal-rerun";
    }

    await prisma.testCase.update({
      where: { id: result.testCaseId },
      data: update,
    });
  }
}
