// apps/api/src/lib/investigator.ts
//
// Investigator v1, Ticket INV.1: a pure failure classifier. No Prisma import - I/O (loading
// TestResult/TestHealingAttempt) lives in the sibling investigator-query.ts, matching the
// pure/query/HTTP layering established by lib/application-model.ts + application-model-store.ts
// and lib/autonomous-planner.ts.
//
// Reuses ai/core/repair-policy.ts's classifyFailureContext/isInfraError, read-only, called
// with { message } only - stdout/stderr/specContent/testTitle are deliberately never supplied
// (see the frozen contract's MUST HAVE #2/#3: getting them would require coupling to self-heal's
// job-shaped, disk-guessing file-discovery machinery, which stable-path protection exists to
// avoid). This measurably narrows which RepairFailureClass values can ever be produced - see
// the frozen contract's mapping table for exactly which.
import { classifyFailureContext, isInfraError, type RepairFailureClass } from "../ai/core/repair-policy.js";

/** Full 8-value roadmap taxonomy, defined for forward compatibility. Only AUTOMATION_DRIFT,
 * ENVIRONMENT_FAILURE, and UNKNOWN are ever actually constructed in v1 - see
 * investigator-certification.test.ts (Ticket INV.4), which proves the other 5 are behaviorally
 * unreachable given v1's inputs, not merely untested. */
export type InvestigatorVerdict =
  | "PRODUCT_DEFECT"
  | "AUTOMATION_DRIFT"
  | "ENVIRONMENT_FAILURE"
  | "DATA_FAILURE"
  | "DEPENDENCY_FAILURE"
  | "SECURITY_ANOMALY"
  | "EXPECTED_CHANGE"
  | "UNKNOWN";

/** Transparent, non-synthetic signal reporting - no numeric confidence score anywhere (matching
 * Autonomous Planner v1's refusal to invent fake quantitative weight for riskTags). `value` is
 * never the classifyFailureContext "unknown" sentinel - that sentinel means "nothing matched,"
 * not a signal in itself. */
export type InvestigatorSignal =
  | { source: "repairFailureClass"; value: Exclude<RepairFailureClass, "unknown"> }
  | { source: "infraError"; value: "infra-error" };

export type InvestigatorResult = {
  verdict: InvestigatorVerdict;
  /** false when there was nothing to classify at all (message null/whitespace-only) - distinct
   * from "classified, and nothing matched" (verdict UNKNOWN with evidenceAvailable: true). */
  evidenceAvailable: boolean;
  matchedSignals: InvestigatorSignal[];
};

/**
 * Frozen precedence (see the contract's MUST HAVE #4): isInfraError is checked first, so a
 * message that happens to resemble both an infra failure and an automation-drift signal is
 * diagnosed as environment, not drift. matchedSignals always reports everything that matched
 * regardless of which one won precedence - precedence decides the verdict, not what's shown.
 */
export function investigateFailure(input: { message: string | null }): InvestigatorResult {
  const message = input.message;
  if (message === null || message.trim() === "") {
    return { verdict: "UNKNOWN", evidenceAvailable: false, matchedSignals: [] };
  }

  const matchedSignals: InvestigatorSignal[] = [];

  const infra = isInfraError(message);
  if (infra) matchedSignals.push({ source: "infraError", value: "infra-error" });

  const repairClasses = classifyFailureContext({ message }).filter(
    (value): value is Exclude<RepairFailureClass, "unknown"> => value !== "unknown"
  );
  for (const value of repairClasses) {
    matchedSignals.push({ source: "repairFailureClass", value });
  }

  const verdict: InvestigatorVerdict = infra ? "ENVIRONMENT_FAILURE" : repairClasses.length > 0 ? "AUTOMATION_DRIFT" : "UNKNOWN";

  return { verdict, evidenceAvailable: true, matchedSignals };
}
