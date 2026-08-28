// Single shared definition of "does this security scan require human approval before it
// can run active/deep checks against production." Previously security.ts, ci.ts, mobile.ts,
// and operator-worker.ts each risked encoding a slightly different version of this
// condition (or, for ci.ts/mobile.ts, none at all) - a route could think a scan was safe
// while the worker executed active checks anyway, or vice versa. Every caller now imports
// this one predicate instead of re-deriving the condition.
// Matches the existing environment enum already used by security.ts's scan-trigger schema
// (z.enum(["dev", "qa", "stage", "prod"])) - not "staging", to stay consistent with what's
// already live rather than introducing a second, incompatible naming convention.
export type ScanEnvironment = "dev" | "qa" | "stage" | "prod";

// environment/scanDepth accept loosely-typed/optional strings (not just ScanEnvironment)
// because some callers (operator-worker.ts's autonomous context) only have unvalidated
// input available — the checks below only ever compare for exact-match against known
// literals, so an unrecognized or missing value just safely falls through as "not that one."
export type ScanApprovalInput = {
  environment?: string;
  scanDepth?: string;
  enableActive: boolean;
  safeMode?: boolean;
};

// For manual (UI) and CI-triggered scans: a human already decided to trigger this specific
// scan, so only the highest-risk combination — active/deep/unsafe testing against production
// — needs a separate approval step. Non-prod active scans are allowed through directly.
export function requiresProductionApproval(input: ScanApprovalInput): boolean {
  return (
    input.environment === "prod" &&
    (input.scanDepth === "deep" || input.enableActive || input.safeMode === false)
  );
}

// For autonomous-agent-triggered scans (operator-worker.ts): deliberately stricter, since no
// human is directly clicking "run this scan" — any active/deep/unsafe test, or any scan
// against prod at all (even passive), needs a human to approve it first. This is an
// intentionally different, broader policy from requiresProductionApproval, not the same
// rule re-derived slightly differently — keep them named and tested separately so a future
// change to one doesn't get silently applied to the other.
export function requiresAutonomousScanApproval(input: ScanApprovalInput): boolean {
  return (
    input.enableActive ||
    input.scanDepth === "deep" ||
    input.safeMode === false ||
    input.environment === "prod"
  );
}

// security-worker.ts's defense-in-depth backstop: true when a job needs production approval
// per requiresProductionApproval and none was recorded on the payload. Kept here (not
// inlined in security-worker.ts) so it's directly unit-testable without importing that
// module's module-scope BullMQ Worker/Redis connection as a side effect.
export function shouldDowngradeToPassive(
  input: ScanApprovalInput & { approvalGranted?: boolean }
): boolean {
  return requiresProductionApproval(input) && !input.approvalGranted;
}
