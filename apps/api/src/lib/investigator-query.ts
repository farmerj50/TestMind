// apps/api/src/lib/investigator-query.ts
//
// Investigator v1: I/O wrapper around investigator.ts's pure classifier. Loads TestResult
// (Ticket INV.2), and will add the TestHealingAttempt healing-history enrichment (Ticket
// INV.3) - kept separate from investigator.ts so that file stays Prisma-free, matching the
// pure/query/HTTP layering established by application-model.ts + application-model-store.ts
// and lib/autonomous-planner.ts.
import { prisma } from "../prisma.js";
import { investigateFailure, type InvestigatorResult } from "./investigator.js";

/**
 * Ticket INV.3. Named for exactly what it means - "the most recent healing attempt did not
 * result in a confirmed success," not "it failed" - since queued/running aren't failures
 * either. A mislabel here would feed misleading data to any later autonomous reasoning that
 * consumes this signal. Reports the TestCase's *current* historical state (most recent
 * attempt only), never "ever succeeded at some point."
 */
export type HealingHistorySignal = "prior-heal-succeeded" | "prior-heal-not-succeeded" | "no-history";

export type InvestigatorQueryResult = InvestigatorResult & { testResultId: string; healingHistory: HealingHistorySignal };

/** Resolves the single most recent TestHealingAttempt for a TestCase (deterministic tie-break
 * on id when multiple attempts share a createdAt) into the pinned 3-value signal. */
async function resolveHealingHistory(testCaseId: string): Promise<HealingHistorySignal> {
  const latest = await prisma.testHealingAttempt.findFirst({
    where: { testCaseId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { status: true },
  });
  if (!latest) return "no-history";
  return latest.status === "succeeded" ? "prior-heal-succeeded" : "prior-heal-not-succeeded";
}

/**
 * Scopes the TestResult lookup to the given project via its TestCase relation, so a
 * testResultId belonging to a different project (or that doesn't exist at all) returns null
 * rather than leaking data across project boundaries - the caller (index.ts) still performs
 * its own separate project-ownership check against the requesting user, matching every other
 * project route's two-layer authorization shape.
 */
export async function investigateTestResult(projectId: string, testResultId: string): Promise<InvestigatorQueryResult | null> {
  const testResult = await prisma.testResult.findFirst({
    where: { id: testResultId, testCase: { projectId } },
    select: { id: true, message: true, testCaseId: true },
  });
  if (!testResult) return null;

  const result = investigateFailure({ message: testResult.message });
  const healingHistory = await resolveHealingHistory(testResult.testCaseId);
  return { ...result, testResultId: testResult.id, healingHistory };
}
