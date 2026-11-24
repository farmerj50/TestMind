// A self-heal repair is a success ONLY when its verification rerun passed. Applying a patch is
// not success. Every verification point (QE / autonomous QA targeted verify, legacy QA retest,
// agent orchestrator retest, standalone self-heal reruns) finalizes attempts through here.
//
// The database stores the outcome in TestHealingAttempt.status ("succeeded" | "failed"); a failed
// verification additionally carries the machine-readable reason code REPAIR_FAILED in `error`,
// so every consumer (Application Brain, run view, PR proposals) can report "repair_failed".

export const REPAIR_FAILED = "repair_failed" as const;

export type VerificationSummary = { passed?: number; failed?: number; errors?: number; total?: number } | null | undefined;

/** Passed = at least one test ran and passed, and nothing failed or errored. */
export function verificationPassed(summary: VerificationSummary): boolean {
  if (!summary) return false;
  return (summary.passed ?? 0) > 0 && (summary.failed ?? 0) === 0 && (summary.errors ?? 0) === 0;
}

export function describeVerification(summary: VerificationSummary): string {
  if (!summary) return "the verification rerun produced no results";
  return `verification rerun: ${summary.passed ?? 0} passed, ${summary.failed ?? 0} failed${summary.errors ? `, ${summary.errors} errored` : ""}`;
}

/** True when a healing attempt's stored error marks it as a failed repair verification. */
export function isRepairFailed(error: string | null | undefined): boolean {
  return typeof error === "string" && error.startsWith(`${REPAIR_FAILED}:`);
}

type HealingDb = {
  testHealingAttempt: {
    updateMany(args: { where: any; data: any }): Promise<{ count: number }>;
  };
};

/**
 * Records the verification rerun on the attempts and sets their final status.
 * `runSucceeded: false` (the rerun itself failed or timed out) always means repair_failed.
 */
export async function finalizeRepairVerification(
  db: HealingDb,
  attemptIds: string[],
  summary: VerificationSummary,
  opts: { runSucceeded?: boolean; detail?: string } = {},
): Promise<"succeeded" | typeof REPAIR_FAILED> {
  const ok = opts.runSucceeded !== false && verificationPassed(summary);
  if (!attemptIds.length) return ok ? "succeeded" : REPAIR_FAILED;
  const executionAfter = summary ? { executionAfter: summary as any } : {};
  await db.testHealingAttempt.updateMany({
    // Never resurrect an attempt that already failed or was skipped.
    where: { id: { in: attemptIds }, status: { in: ["succeeded", "needs_review", "running", "queued"] } },
    data: ok
      ? { ...executionAfter, status: "succeeded", error: null }
      : { ...executionAfter, status: "failed", error: `${REPAIR_FAILED}: ${(opts.detail ?? describeVerification(summary)).slice(0, 900)}` },
  });
  return ok ? "succeeded" : REPAIR_FAILED;
}
