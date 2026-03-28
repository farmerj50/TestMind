import { prisma } from "../prisma.js";

type FinalizeInput = {
  runId: string;
  source?: "run" | "self-heal-rerun" | "qa-verify";
};

/**
 * After any run completes, write a canonical "latest execution snapshot"
 * onto each TestCase that had a result in that run. This is the single
 * source of truth for dashboard / project views — it avoids inferring
 * status by scanning run history at read time.
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

  const isSelfHealRerun = run.trigger === "self-heal" || source === "self-heal-rerun";

  for (const result of run.results) {
    const update: Parameters<typeof prisma.testCase.update>[0]["data"] = {
      lastResultStatus: result.status,
      lastRunId: run.id,
      lastRunAt: run.finishedAt ?? run.startedAt ?? run.createdAt,
      lastFailureMessage:
        result.status === "failed" || result.status === "error"
          ? (result.message ?? null)
          : null,
      lastSource: isSelfHealRerun ? "self-heal-rerun" : source,
    };

    // If this is a passing rerun from self-heal, record the heal provenance
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
    }

    await prisma.testCase.update({
      where: { id: result.testCaseId },
      data: update,
    });
  }
}
