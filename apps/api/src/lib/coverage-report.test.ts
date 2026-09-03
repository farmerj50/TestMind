import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getWorkflowCoverageReport } from "./coverage-report.js";
import type { ApplicationBrainSnapshot } from "./application-brain-query.js";

// Ticket CS.1 - pure-function unit tests, zero I/O (matches autonomous-planner.test.ts's
// no-DB-needed style). Builds minimal ApplicationBrainSnapshot fixtures directly, the same way
// autonomous-planner.test.ts does - getWorkflowCoverageReport only ever reads
// snapshot.workflows, snapshot.qaFailures, and snapshot.securityFindings.

function workflowCoverage(overrides: Partial<ApplicationBrainSnapshot["workflows"][number]> = {}): ApplicationBrainSnapshot["workflows"][number] {
  return {
    key: "checkout",
    name: "Checkout",
    riskTags: [],
    routeHints: ["/checkout"],
    apiHints: [],
    coveredRouteHints: 0,
    totalRouteHints: 1,
    coveragePercent: 0,
    observedApiHints: 0,
    totalApiHints: 0,
    ...overrides,
  };
}

function baseSnapshot(overrides: Partial<ApplicationBrainSnapshot> = {}): ApplicationBrainSnapshot {
  return {
    store: { version: 2, pages: {}, apis: {}, identities: {}, resources: {}, workflows: {}, testLinks: {} },
    coverage: [],
    qaFailures: [],
    securityFindings: { attributed: [], notAttributable: [] },
    workflows: [],
    ...overrides,
  };
}

test("a fully covered workflow: coveragePercent 100, coverageGapPercent 0", () => {
  const snapshot = baseSnapshot({ workflows: [workflowCoverage({ coveragePercent: 100 })] });
  const report = getWorkflowCoverageReport(snapshot);
  assert.equal(report.workflows[0].coveragePercent, 100);
  assert.equal(report.workflows[0].coverageGapPercent, 0);
});

test("a partially covered workflow: coverageGapPercent is exactly 100 - coveragePercent", () => {
  const snapshot = baseSnapshot({ workflows: [workflowCoverage({ coveragePercent: 62 })] });
  const report = getWorkflowCoverageReport(snapshot);
  assert.equal(report.workflows[0].coveragePercent, 62);
  assert.equal(report.workflows[0].coverageGapPercent, 38);
});

test("a workflow with zero declared routeHints: both coveragePercent and coverageGapPercent are null, never 0", () => {
  const snapshot = baseSnapshot({ workflows: [workflowCoverage({ routeHints: [], totalRouteHints: 0, coveragePercent: null })] });
  const report = getWorkflowCoverageReport(snapshot);
  assert.equal(report.workflows[0].coveragePercent, null);
  assert.equal(report.workflows[0].coverageGapPercent, null, "null (nothing to divide by), not 0, which would misrepresent 'no data' as 'no gap'");
});

test("qaFailuresCount is a raw count of failures joined by routeHint membership, not weighted by confidence", () => {
  const snapshot = baseSnapshot({
    workflows: [workflowCoverage({ routeHints: ["/checkout"], coveragePercent: 100 })],
    qaFailures: [
      { testCaseId: "a", routeHint: "/checkout", confidence: "linked", lastResultStatus: "failed", lastFailureMessage: null, lastHealedAt: null, lastRunAt: null },
      { testCaseId: "b", routeHint: "/checkout", confidence: "inferred", lastResultStatus: "failed", lastFailureMessage: null, lastHealedAt: null, lastRunAt: null },
      { testCaseId: "c", routeHint: "/unrelated-route", confidence: "linked", lastResultStatus: "failed", lastFailureMessage: null, lastHealedAt: null, lastRunAt: null },
    ],
  });
  const report = getWorkflowCoverageReport(snapshot);
  assert.equal(report.workflows[0].qaFailuresCount, 2, "linked and inferred both count as 1; the unrelated route must not count");
});

test("securityFindingsByValidationStatus buckets attributed findings by routeHint membership and validationStatus, including untriaged", () => {
  const snapshot = baseSnapshot({
    workflows: [workflowCoverage({ routeHints: ["/checkout"], coveragePercent: 100 })],
    securityFindings: {
      attributed: [
        { id: "f1", routeHint: "/checkout", severity: "high", title: "a", tool: "idor-engine", validationStatus: "confirmed" },
        { id: "f2", routeHint: "/checkout", severity: "medium", title: "b", tool: "cors-audit", validationStatus: "confirmed" },
        { id: "f3", routeHint: "/checkout", severity: "low", title: "c", tool: "idor-engine", validationStatus: null },
        { id: "f4", routeHint: "/unrelated-route", severity: "critical", title: "d", tool: "idor-engine", validationStatus: "confirmed" },
      ],
      notAttributable: [],
    },
  });
  const report = getWorkflowCoverageReport(snapshot);
  const counts = report.workflows[0].securityFindingsByValidationStatus;
  assert.equal(counts.confirmed, 2, "only the two /checkout-attributed confirmed findings count; the unrelated route must not");
  assert.equal(counts.untriaged, 1);
  assert.equal(counts.likely, 0);
  assert.equal(counts.suspected, 0);
  assert.equal(counts.inconclusive, 0);
  assert.equal(counts.not_exploitable, 0);
  assert.equal(counts.false_positive, 0);
  assert.equal(counts.not_applicable, 0);
});

test("notAttributableFindings is a passthrough of the Brain's own list, never blended into any workflow's counts", () => {
  const notAttributable: ApplicationBrainSnapshot["securityFindings"]["notAttributable"] = [
    { id: "na1", severity: "medium", title: "x", tool: "code-review", location: "a.ts:1", validationStatus: null },
  ];
  const snapshot = baseSnapshot({
    workflows: [workflowCoverage({ coveragePercent: 100 })],
    securityFindings: { attributed: [], notAttributable },
  });
  const report = getWorkflowCoverageReport(snapshot);
  assert.deepEqual(report.notAttributableFindings, notAttributable);
  assert.deepEqual(report.workflows[0].securityFindingsByValidationStatus, {
    confirmed: 0, likely: 0, suspected: 0, inconclusive: 0, not_exploitable: 0, false_positive: 0, not_applicable: 0, untriaged: 0,
  });
});

test("openItems.untriagedFindingsCount counts both attributed and notAttributable findings project-wide", () => {
  const snapshot = baseSnapshot({
    workflows: [],
    securityFindings: {
      attributed: [
        { id: "f1", routeHint: "/a", severity: "high", title: "a", tool: "idor-engine", validationStatus: null },
        { id: "f2", routeHint: "/b", severity: "high", title: "b", tool: "idor-engine", validationStatus: "confirmed" },
      ],
      notAttributable: [{ id: "na1", severity: "medium", title: "c", tool: "code-review", location: "a.ts:1", validationStatus: null }],
    },
  });
  const report = getWorkflowCoverageReport(snapshot);
  assert.equal(report.openItems.untriagedFindingsCount, 2, "one untriaged attributed + one untriaged notAttributable");
});

test("openItems.unresolvedQaFailuresCount counts qaFailures with lastHealedAt === null, project-wide", () => {
  const snapshot = baseSnapshot({
    workflows: [],
    qaFailures: [
      { testCaseId: "a", routeHint: "/a", confidence: "linked", lastResultStatus: "failed", lastFailureMessage: null, lastHealedAt: null, lastRunAt: null },
      { testCaseId: "b", routeHint: "/b", confidence: "linked", lastResultStatus: "failed", lastFailureMessage: null, lastHealedAt: "2026-01-01T00:00:00.000Z", lastRunAt: null },
    ],
  });
  const report = getWorkflowCoverageReport(snapshot);
  assert.equal(report.openItems.unresolvedQaFailuresCount, 1, "only the un-healed failure counts");
});

test("the output contains no recommendation/verdict/saturation field of any kind", () => {
  const snapshot = baseSnapshot({ workflows: [workflowCoverage({ coveragePercent: 50 })] });
  const report = getWorkflowCoverageReport(snapshot);
  const serialized = JSON.stringify(report).toLowerCase();
  for (const forbidden of ["saturation", "recommend", "stop", "continue", "verdict", "residualrisk", "residual_risk"]) {
    assert.ok(!serialized.includes(forbidden), `output must never contain a "${forbidden}"-shaped field or value`);
  }
});

test("structural check: coverage-report.ts has zero dependency on autonomous-planner.ts and never calls rankWorkflowRisk", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const source = fs.readFileSync(path.join(here, "coverage-report.ts"), "utf8");
  const importLines = source.split("\n").filter((line) => /^\s*import\b/.test(line));
  assert.ok(
    importLines.every((line) => !line.includes("autonomous-planner")),
    "coverage-report.ts must not have an import statement referencing autonomous-planner.ts (comments mentioning it by name, explaining why, are fine)"
  );
  assert.ok(!source.includes("rankWorkflowRisk("), "coverage-report.ts must never call rankWorkflowRisk");
});
