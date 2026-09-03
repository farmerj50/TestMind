// apps/api/src/lib/application-brain-query.ts
//
// Application Brain v1, Ticket AB.2: read-only query layer. Never writes to TestCase or
// SecurityFinding - only joins against them, so this file has zero effect on either table's
// existing behavior no matter what it returns.
import { prisma } from "../prisma.js";
import { normalizeApplicationModel, normalizeRouteHint, type ApplicationModelStore } from "./application-model.js";

// Tools whose SecurityFinding.location is a genuine URL/path, safe to route-match via
// normalizeRouteHint. Verified by reading every security/modules/*.ts location: assignment.
// Everything else (code-review: file:line, graphql-audit: composite "endpoint → op.name",
// jwt-analyzer: opaque token source, subdomain-enum: bare domain) goes into the
// notAttributable bucket instead of being silently dropped or mis-attributed - see the frozen
// contract's MUST HAVE #8.
// Exported (Ticket CS.0) so callers outside this file - specifically
// security-regression-persist.ts, which needs the identical eligibility check before writing a
// route into a TestCase's preconditions - reuse this single source of truth rather than
// duplicating it and risking the two lists drifting apart.
export const URL_SHAPED_FINDING_TOOLS = new Set([
  "idor-engine",
  "cors-audit",
  "business-logic",
  "perf-baseline",
  "anomaly-baseline-agent",
  "intelligent-security-agent",
  "js-endpoint-extractor",
  "mobile-scan",
  "nuclei",
  "openapi-scan",
  "race-condition",
  "owasp-zap",
]);

type ConfidenceTag = "linked" | "inferred";

export type CoverageEntry = {
  routeHint: string;
  testCaseId: string;
  confidence: ConfidenceTag;
  lastResultStatus: string | null;
  lastRunAt: string | null;
};

export type QaFailure = {
  testCaseId: string;
  routeHint: string;
  confidence: ConfidenceTag;
  lastResultStatus: string;
  lastFailureMessage: string | null;
  lastHealedAt: string | null;
  lastRunAt: string | null;
};

// Ticket VR.2 (Validation + Regression v1). Null means untriaged - a human hasn't looked at
// this finding yet. Set only via PATCH /security/findings/:id/validation-status; never
// computed here, never blended into any score (Autonomous Planner v1's formula is untouched).
export type FindingValidationStatus =
  | "confirmed"
  | "likely"
  | "suspected"
  | "inconclusive"
  | "not_exploitable"
  | "false_positive"
  | "not_applicable"
  | null;

export type AttributedFinding = {
  id: string;
  routeHint: string;
  severity: string;
  title: string;
  tool: string | null;
  validationStatus: FindingValidationStatus;
};

export type NotAttributableFinding = {
  id: string;
  severity: string;
  title: string;
  tool: string | null;
  location: string | null;
  validationStatus: FindingValidationStatus;
};

export type WorkflowCoverage = {
  key: string;
  name: string;
  riskTags: string[];
  routeHints: string[];
  apiHints: string[];
  coveredRouteHints: number;
  totalRouteHints: number;
  // Covered route hints / total declared route hints, per the frozen AB.3 contract. null (not
  // 0) when the workflow declares zero routeHints - there's nothing to divide by, and 0% would
  // wrongly read as "declared but untested."
  coveragePercent: number | null;
  // apiHints are reported here, separately, and are never blended into coveragePercent above -
  // see AB.3's contract for why (a 3-page/7-API workflow shouldn't force a weighting decision).
  observedApiHints: number;
  totalApiHints: number;
};

export type ApplicationBrainSnapshot = {
  store: ApplicationModelStore;
  coverage: CoverageEntry[];
  qaFailures: QaFailure[];
  securityFindings: {
    attributed: AttributedFinding[];
    notAttributable: NotAttributableFinding[];
  };
  workflows: WorkflowCoverage[];
};

/**
 * Best-effort route inference for TestCase rows with no Brain testLink (pre-Brain historical
 * rows, or cases a future producer hasn't wired up yet). Two known shapes, both discovered by
 * tracing every TestCase-creating call site during the design of this ticket:
 *   - url-inspector.ts's save flow: preconditions is real JSON, {route: "..."} is structured.
 *   - operator-worker.ts's pre-testLinks discovery cases: key = `discovery/{projectId}/{page}#{title}`.
 * Anything else (persist-run-results.ts's cases, keyed only by `${specFile}#${testName}` with
 * no route in scope at all) is unresolvable and deliberately excluded from the route-indexed
 * rollup rather than guessed at - see the frozen contract's MUST HAVE #7 for why.
 */
function inferRouteHintFromTestCase(tc: { key: string; preconditions: string | null }): string | null {
  if (tc.preconditions) {
    try {
      const parsed = JSON.parse(tc.preconditions);
      if (parsed && typeof parsed.route === "string" && parsed.route.trim()) {
        return normalizeRouteHint(parsed.route);
      }
    } catch {
      // not JSON, or not the expected shape - fall through to key-based inference
    }
  }
  const match = tc.key.match(/^discovery\/[^/]+\/(.+)#[^#]*$/);
  if (match) return normalizeRouteHint(match[1]);
  return null;
}

function isFailure(status: string | null): status is string {
  return status === "failed" || status === "error";
}

export async function getApplicationBrainSnapshot(projectId: string): Promise<ApplicationBrainSnapshot> {
  const project = await prisma.project.findUniqueOrThrow({
    where: { id: projectId },
    select: { applicationModel: true },
  });
  const store = normalizeApplicationModel(project.applicationModel);

  const allCases = await prisma.testCase.findMany({
    where: { projectId },
    select: {
      id: true,
      key: true,
      preconditions: true,
      lastResultStatus: true,
      lastRunAt: true,
      lastFailureMessage: true,
      lastHealedAt: true,
    },
  });
  const casesById = new Map(allCases.map((tc) => [tc.id, tc]));
  const linkedCaseIds = new Set(Object.values(store.testLinks).map((link) => link.testCaseId));

  const coverage: CoverageEntry[] = [];
  const qaFailures: QaFailure[] = [];

  function record(tc: (typeof allCases)[number], routeHint: string, confidence: ConfidenceTag) {
    const lastRunAt = tc.lastRunAt ? tc.lastRunAt.toISOString() : null;
    coverage.push({ routeHint, testCaseId: tc.id, confidence, lastResultStatus: tc.lastResultStatus, lastRunAt });
    if (isFailure(tc.lastResultStatus)) {
      qaFailures.push({
        testCaseId: tc.id,
        routeHint,
        confidence,
        lastResultStatus: tc.lastResultStatus,
        lastFailureMessage: tc.lastFailureMessage,
        lastHealedAt: tc.lastHealedAt ? tc.lastHealedAt.toISOString() : null,
        lastRunAt,
      });
    }
  }

  // testLinks first (confidence: "linked") - the durable, Brain-owned relationship.
  for (const link of Object.values(store.testLinks)) {
    const tc = casesById.get(link.testCaseId);
    if (!tc) continue; // link points at a since-deleted TestCase
    record(tc, link.routeHint, "linked");
  }

  // Everything else: best-effort fallback (confidence: "inferred"), only for cases not
  // already covered by a real link.
  for (const tc of allCases) {
    if (linkedCaseIds.has(tc.id)) continue;
    const routeHint = inferRouteHintFromTestCase(tc);
    if (!routeHint) continue;
    record(tc, routeHint, "inferred");
  }

  const findings = await prisma.securityFinding.findMany({
    where: { scan: { projectId } },
    select: { id: true, severity: true, title: true, tool: true, location: true, validationStatus: true },
  });

  const attributed: AttributedFinding[] = [];
  const notAttributable: NotAttributableFinding[] = [];
  for (const finding of findings) {
    if (finding.tool && URL_SHAPED_FINDING_TOOLS.has(finding.tool) && finding.location) {
      attributed.push({
        id: finding.id,
        routeHint: normalizeRouteHint(finding.location),
        severity: finding.severity,
        title: finding.title,
        tool: finding.tool,
        validationStatus: finding.validationStatus,
      });
      continue;
    }
    notAttributable.push({
      id: finding.id,
      severity: finding.severity,
      title: finding.title,
      tool: finding.tool,
      location: finding.location,
      validationStatus: finding.validationStatus,
    });
  }

  const coveredRouteHintSet = new Set(coverage.map((entry) => entry.routeHint));
  const workflows: WorkflowCoverage[] = Object.entries(store.workflows).map(([key, workflow]) => {
    const coveredRouteHints = workflow.routeHints.filter((rh) => coveredRouteHintSet.has(rh)).length;
    const totalRouteHints = workflow.routeHints.length;
    const observedApiHints = workflow.apiHints.filter((ah) => ah in store.apis).length;
    return {
      key,
      name: workflow.name,
      riskTags: workflow.riskTags,
      routeHints: workflow.routeHints,
      apiHints: workflow.apiHints,
      coveredRouteHints,
      totalRouteHints,
      coveragePercent: totalRouteHints === 0 ? null : (coveredRouteHints / totalRouteHints) * 100,
      observedApiHints,
      totalApiHints: workflow.apiHints.length,
    };
  });

  return { store, coverage, qaFailures, securityFindings: { attributed, notAttributable }, workflows };
}
