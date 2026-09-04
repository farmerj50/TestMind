import test from "node:test";
import assert from "node:assert/strict";
import { rankWorkflowRisk, MAX_POSSIBLE_SCORE, parseTopN, isValidAsOf, type PlannerItem } from "./autonomous-planner.js";
import type { ApplicationBrainSnapshot } from "./application-brain-query.js";
import type { ApplicationModelPage, ApplicationModelWorkflow } from "./application-model.js";

// Ticket AP.2 - pure-function unit tests, zero I/O (matches application-model.test.ts's
// no-DB-needed style). Builds minimal ApplicationBrainSnapshot fixtures directly rather than
// going through Prisma - rankWorkflowRisk only ever reads snapshot.workflows, snapshot.store
// .pages, snapshot.qaFailures, and snapshot.securityFindings.attributed, so those are the only
// fields these fixtures need to populate meaningfully.

const NOW = "2026-01-15T00:00:00.000Z";

function page(lastChangedAt: string): ApplicationModelPage {
  return { routeHint: "/x", forms: [], signature: "s", firstSeenAt: lastChangedAt, lastSeenAt: lastChangedAt, lastChangedAt, consecutiveMisses: 0 };
}

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

test("a workflow with zero declared routeHints (coveragePercent: null) lands in unrankable, not ranked, and is never scored as 0", () => {
  const snapshot = baseSnapshot({ workflows: [workflowCoverage({ routeHints: [], totalRouteHints: 0, coveragePercent: null })] });
  const { ranked, unrankable } = rankWorkflowRisk(snapshot, NOW);
  assert.equal(ranked.length, 0);
  assert.equal(unrankable.length, 1);
  assert.equal(unrankable[0].key, "checkout");
  assert.equal(unrankable[0].reason, "no declared routeHints");
});

test("coverage-gap-only: score is exactly (100 - coveragePercent) * 0.4, capped contribution 40 at 0% coverage", () => {
  const zeroCoverage = baseSnapshot({ workflows: [workflowCoverage({ coveragePercent: 0 })] });
  assert.equal(rankWorkflowRisk(zeroCoverage, NOW).ranked[0].score, 40);
  assert.equal(rankWorkflowRisk(zeroCoverage, NOW).ranked[0].breakdown.coverageGap, 40);

  const halfCoverage = baseSnapshot({ workflows: [workflowCoverage({ coveragePercent: 50 })] });
  assert.equal(rankWorkflowRisk(halfCoverage, NOW).ranked[0].score, 20);

  const fullCoverage = baseSnapshot({ workflows: [workflowCoverage({ coveragePercent: 100 })] });
  assert.equal(rankWorkflowRisk(fullCoverage, NOW).ranked[0].score, 0);
});

test("qa-failures-only: linked=+10, inferred=+5, joined by routeHint membership, unrelated routes ignored, capped at 30", () => {
  const snapshot = baseSnapshot({
    workflows: [workflowCoverage({ routeHints: ["/checkout"], coveragePercent: 100 })],
    qaFailures: [
      { testCaseId: "a", routeHint: "/checkout", confidence: "linked", lastResultStatus: "failed", lastFailureMessage: null, lastHealedAt: null, lastRunAt: null },
      { testCaseId: "b", routeHint: "/other-workflow-route", confidence: "linked", lastResultStatus: "failed", lastFailureMessage: null, lastHealedAt: null, lastRunAt: null },
    ],
  });
  const item = rankWorkflowRisk(snapshot, NOW).ranked[0];
  assert.equal(item.breakdown.qaFailures, 10, "unrelated route's failure must not contribute");
  assert.equal(item.score, 10);

  const inferred = baseSnapshot({
    workflows: [workflowCoverage({ routeHints: ["/checkout"], coveragePercent: 100 })],
    qaFailures: [{ testCaseId: "c", routeHint: "/checkout", confidence: "inferred", lastResultStatus: "failed", lastFailureMessage: null, lastHealedAt: null, lastRunAt: null }],
  });
  assert.equal(rankWorkflowRisk(inferred, NOW).ranked[0].breakdown.qaFailures, 5);

  const manyFailures = baseSnapshot({
    workflows: [workflowCoverage({ routeHints: ["/checkout"], coveragePercent: 100 })],
    qaFailures: Array.from({ length: 5 }, (_, i) => ({
      testCaseId: `case-${i}`,
      routeHint: "/checkout",
      confidence: "linked" as const,
      lastResultStatus: "failed",
      lastFailureMessage: null,
      lastHealedAt: null,
      lastRunAt: null,
    })),
  });
  assert.equal(rankWorkflowRisk(manyFailures, NOW).ranked[0].breakdown.qaFailures, 30, "5 linked failures (50 raw pts) must cap at 30");
});

test("security-findings-only: points by severity, joined by routeHint membership, capped at 30, notAttributable never scored", () => {
  const severities: Array<{ severity: string; points: number }> = [
    { severity: "critical", points: 12 },
    { severity: "high", points: 8 },
    { severity: "medium", points: 4 },
    { severity: "low", points: 2 },
    { severity: "info", points: 1 },
  ];
  for (const { severity, points } of severities) {
    const snapshot = baseSnapshot({
      workflows: [workflowCoverage({ routeHints: ["/checkout"], coveragePercent: 100 })],
      securityFindings: {
        attributed: [{ id: "f1", routeHint: "/checkout", severity, title: "finding", tool: "idor-engine", validationStatus: null, createdAt: NOW, scanId: "scan1" }],
        notAttributable: [{ id: "f2", severity: "critical", title: "unattributed", tool: "code-review", location: "x:1", validationStatus: null, createdAt: NOW, scanId: "scan1" }],
      },
    });
    const item = rankWorkflowRisk(snapshot, NOW).ranked[0];
    assert.equal(item.breakdown.securityFindings, points, `severity ${severity} should contribute ${points}`);
  }

  const manyFindings = baseSnapshot({
    workflows: [workflowCoverage({ routeHints: ["/checkout"], coveragePercent: 100 })],
    securityFindings: {
      attributed: Array.from({ length: 3 }, (_, i) => ({ id: `f${i}`, routeHint: "/checkout", severity: "critical", title: "x", tool: "idor-engine", validationStatus: null, createdAt: NOW, scanId: "scan1" })),
      notAttributable: [],
    },
  });
  assert.equal(rankWorkflowRisk(manyFindings, NOW).ranked[0].breakdown.securityFindings, 30, "3 critical findings (36 raw pts) must cap at 30");
});

test("riskTags: flat +5 bonus if non-empty, 0 if empty, never scaled by count", () => {
  const withTags = baseSnapshot({ workflows: [workflowCoverage({ coveragePercent: 100, riskTags: ["critical", "pci", "financial"] })] });
  assert.equal(rankWorkflowRisk(withTags, NOW).ranked[0].breakdown.riskTags, 5, "3 tags must not score higher than 1 tag");

  const oneTag = baseSnapshot({ workflows: [workflowCoverage({ coveragePercent: 100, riskTags: ["critical"] })] });
  assert.equal(rankWorkflowRisk(oneTag, NOW).ranked[0].breakdown.riskTags, 5);

  const noTags = baseSnapshot({ workflows: [workflowCoverage({ coveragePercent: 100, riskTags: [] })] });
  assert.equal(rankWorkflowRisk(noTags, NOW).ranked[0].breakdown.riskTags, 0);
});

test("recently-changed: +5 if any workflow routeHint's page changed within the 7-day window, 0 outside it, 0 for a route with no known page", () => {
  const withinWindow = baseSnapshot({
    workflows: [workflowCoverage({ routeHints: ["/checkout"], coveragePercent: 100 })],
    store: { version: 2, pages: { "/checkout": page("2026-01-10T00:00:00.000Z") }, apis: {}, identities: {}, resources: {}, workflows: {}, testLinks: {} },
  });
  assert.equal(rankWorkflowRisk(withinWindow, NOW).ranked[0].breakdown.recentlyChanged, 5, "5 days before NOW is inside the 7-day window");

  const outsideWindow = baseSnapshot({
    workflows: [workflowCoverage({ routeHints: ["/checkout"], coveragePercent: 100 })],
    store: { version: 2, pages: { "/checkout": page("2026-01-01T00:00:00.000Z") }, apis: {}, identities: {}, resources: {}, workflows: {}, testLinks: {} },
  });
  assert.equal(rankWorkflowRisk(outsideWindow, NOW).ranked[0].breakdown.recentlyChanged, 0, "14 days before NOW is outside the 7-day window");

  const futureDated = baseSnapshot({
    workflows: [workflowCoverage({ routeHints: ["/checkout"], coveragePercent: 100 })],
    store: { version: 2, pages: { "/checkout": page("2026-02-01T00:00:00.000Z") }, apis: {}, identities: {}, resources: {}, workflows: {}, testLinks: {} },
  });
  assert.equal(rankWorkflowRisk(futureDated, NOW).ranked[0].breakdown.recentlyChanged, 0, "a future-dated lastChangedAt (clock skew) must not read as recently changed");

  const noKnownPage = baseSnapshot({ workflows: [workflowCoverage({ routeHints: ["/never-discovered"], coveragePercent: 100 })] });
  assert.equal(rankWorkflowRisk(noKnownPage, NOW).ranked[0].breakdown.recentlyChanged, 0, "a routeHint with no matching page record must not throw or score");
});

test("the function never reads the system clock: identical snapshot + now produces byte-identical output across calls", () => {
  const snapshot = baseSnapshot({
    workflows: [workflowCoverage({ coveragePercent: 60, riskTags: ["critical"] })],
    qaFailures: [{ testCaseId: "a", routeHint: "/checkout", confidence: "linked", lastResultStatus: "failed", lastFailureMessage: null, lastHealedAt: null, lastRunAt: null }],
  });
  const a = rankWorkflowRisk(snapshot, NOW);
  const b = rankWorkflowRisk(snapshot, NOW);
  assert.deepEqual(a, b);
});

test("all five signals combined reach exactly MAX_POSSIBLE_SCORE (110) when every dimension is maxed", () => {
  const snapshot = baseSnapshot({
    workflows: [workflowCoverage({ routeHints: ["/checkout"], coveragePercent: 0, riskTags: ["critical"] })],
    qaFailures: Array.from({ length: 5 }, (_, i) => ({
      testCaseId: `case-${i}`,
      routeHint: "/checkout",
      confidence: "linked" as const,
      lastResultStatus: "failed",
      lastFailureMessage: null,
      lastHealedAt: null,
      lastRunAt: null,
    })),
    securityFindings: {
      attributed: Array.from({ length: 3 }, (_, i) => ({ id: `f${i}`, routeHint: "/checkout", severity: "critical", title: "x", tool: "idor-engine", validationStatus: null, createdAt: NOW, scanId: "scan1" })),
      notAttributable: [],
    },
    store: { version: 2, pages: { "/checkout": page("2026-01-10T00:00:00.000Z") }, apis: {}, identities: {}, resources: {}, workflows: {}, testLinks: {} },
  });
  const item = rankWorkflowRisk(snapshot, NOW).ranked[0];
  assert.equal(item.score, MAX_POSSIBLE_SCORE);
  assert.equal(item.score, 110);
});

test("ranked is sorted by score descending, ties broken by workflow name ascending, deterministically", () => {
  const snapshot = baseSnapshot({
    workflows: [
      workflowCoverage({ key: "zeta", name: "Zeta", coveragePercent: 100 }), // score 0
      workflowCoverage({ key: "beta", name: "Beta", coveragePercent: 0 }), // score 40
      workflowCoverage({ key: "alpha", name: "Alpha", coveragePercent: 0 }), // score 40, tie with beta
    ],
  });
  const { ranked } = rankWorkflowRisk(snapshot, NOW);
  assert.deepEqual(ranked.map((r) => r.name), ["Alpha", "Beta", "Zeta"], "tied scores break by name ascending; the clear loser sorts last");
});

test("topN truncates ranked only, never unrankable", () => {
  const snapshot = baseSnapshot({
    workflows: [
      workflowCoverage({ key: "a", name: "A", coveragePercent: 0 }),
      workflowCoverage({ key: "b", name: "B", coveragePercent: 10 }),
      workflowCoverage({ key: "c", name: "C", routeHints: [], totalRouteHints: 0, coveragePercent: null }),
    ],
  });
  const { ranked, unrankable } = rankWorkflowRisk(snapshot, NOW, { topN: 1 });
  assert.equal(ranked.length, 1);
  assert.equal(unrankable.length, 1, "topN must not affect unrankable");
});

// Ticket AP.3 - the query-param helpers the route calls. Tested directly here since index.ts
// can never be imported from a test (it calls app.listen() at module scope).

test("parseTopN: every pinned edge case resolves to the default (20) or the parsed integer, never throws", () => {
  assert.equal(parseTopN(undefined), 20, "missing");
  assert.equal(parseTopN("not-a-number"), 20, "non-numeric");
  assert.equal(parseTopN("1.5"), 20, "non-integer");
  assert.equal(parseTopN("0"), 20, "below minimum");
  assert.equal(parseTopN("-5"), 20, "negative");
  assert.equal(parseTopN("101"), 20, "above maximum");
  assert.equal(parseTopN("1"), 1, "exactly the minimum is valid");
  assert.equal(parseTopN("100"), 100, "exactly the maximum is valid");
  assert.equal(parseTopN("20"), 20, "a normal in-range value");
});

test("isValidAsOf: requires a complete ISO-8601 timestamp with an explicit timezone/offset", () => {
  assert.equal(isValidAsOf("2026-09-03T12:00:00.000Z"), true, "Z offset");
  assert.equal(isValidAsOf("2026-09-03T12:00:00+00:00"), true, "explicit +00:00 offset");
  assert.equal(isValidAsOf("2026-09-03T12:00:00-05:00"), true, "negative offset");
  assert.equal(isValidAsOf("2026-09-03T12:00:00"), false, "timezone-less - must be rejected even though Date.parse() accepts it");
  assert.equal(isValidAsOf("2026-09-03"), false, "date only, no time/timezone");
  assert.equal(isValidAsOf("not-a-date"), false, "garbage input");
  assert.equal(isValidAsOf("2026-13-45T12:00:00.000Z"), false, "syntactically ISO-shaped but not a real calendar date");
});
