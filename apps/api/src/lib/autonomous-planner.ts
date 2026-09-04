// apps/api/src/lib/autonomous-planner.ts
//
// Autonomous Planner v1, Ticket AP.2: a pure workflow-level risk scorer. No Prisma import -
// same discipline as lib/application-model.ts - I/O lives in the caller (Ticket AP.3). Its
// only input is an already-computed ApplicationBrainSnapshot; it invents no new joins of its
// own (see the frozen contract's "Application Brain becomes the sole planner input" framing).
//
// The formula below is frozen by Ticket AP.1's contract text - do not change weights/caps here
// without reopening that contract. It is a fixed v1 proxy, not a general/learned risk engine
// (explicitly out of scope - see NOT INCLUDED).
import type { ApplicationBrainSnapshot } from "./application-brain-query.js";

const RECENTLY_CHANGED_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const MAX_COVERAGE_GAP_POINTS = 40;
const MAX_QA_FAILURE_POINTS = 30;
const MAX_SECURITY_FINDING_POINTS = 30;
const RISK_TAGS_BONUS = 5;
const RECENTLY_CHANGED_BONUS = 5;
/** Sum of the five caps above - the highest raw score a single workflow can reach in v1. Not
 * enforced as a runtime clamp; pinned here so a test can assert the ceiling directly (see
 * autonomous-planner.test.ts) and catch a future change that accidentally normalizes/clips. */
export const MAX_POSSIBLE_SCORE = 110;

const QA_FAILURE_POINTS: Record<"linked" | "inferred", number> = {
  linked: 10,
  inferred: 5,
};

const SECURITY_SEVERITY_POINTS: Record<string, number> = {
  critical: 12,
  high: 8,
  medium: 4,
  low: 2,
  info: 1,
};

export type PlannerScoreBreakdown = {
  coverageGap: number;
  qaFailures: number;
  securityFindings: number;
  riskTags: number;
  recentlyChanged: number;
};

export type PlannerItem = {
  key: string;
  name: string;
  score: number;
  breakdown: PlannerScoreBreakdown;
  coveragePercent: number;
  routeHints: string[];
  riskTags: string[];
};

export type UnrankableWorkflow = {
  key: string;
  name: string;
  reason: string;
};

/**
 * Ranks every workflow in the snapshot by a fixed, documented v1 risk formula. `now` must be
 * an ISO-8601 timestamp supplied by the caller - this function never reads the system clock,
 * so its output is a pure function of its two inputs (required for AP.3/AP.4's "same input
 * twice -> byte-identical output" certification requirement).
 *
 * A workflow with coveragePercent === null (zero declared routeHints, per AB.3's own contract)
 * cannot be scored on any dimension - every signal below is joined via routeHints - so it is
 * excluded from `ranked` and reported in `unrankable` with a reason, never silently dropped
 * and never scored as 0 (which would misrepresent "no data" as "no risk").
 *
 * `opts.topN`, if provided, truncates `ranked` only - never `unrankable`. Bounds validation
 * (integer 1-100, default 20) is the caller's responsibility (Ticket AP.3); this function
 * accepts any non-negative integer and simply slices.
 */
export function rankWorkflowRisk(
  snapshot: ApplicationBrainSnapshot,
  now: string,
  opts?: { topN?: number }
): { ranked: PlannerItem[]; unrankable: UnrankableWorkflow[] } {
  const nowMs = new Date(now).getTime();
  const ranked: PlannerItem[] = [];
  const unrankable: UnrankableWorkflow[] = [];

  for (const workflow of snapshot.workflows) {
    if (workflow.coveragePercent === null) {
      unrankable.push({ key: workflow.key, name: workflow.name, reason: "no declared routeHints" });
      continue;
    }

    const routeHintSet = new Set(workflow.routeHints);

    const coverageGap = (100 - workflow.coveragePercent) * (MAX_COVERAGE_GAP_POINTS / 100);

    let qaFailures = 0;
    for (const failure of snapshot.qaFailures) {
      if (!routeHintSet.has(failure.routeHint)) continue;
      qaFailures += QA_FAILURE_POINTS[failure.confidence];
    }
    qaFailures = Math.min(qaFailures, MAX_QA_FAILURE_POINTS);

    let securityFindings = 0;
    for (const finding of snapshot.securityFindings.attributed) {
      if (!routeHintSet.has(finding.routeHint)) continue;
      securityFindings += SECURITY_SEVERITY_POINTS[finding.severity] ?? 0;
    }
    securityFindings = Math.min(securityFindings, MAX_SECURITY_FINDING_POINTS);

    const riskTags = workflow.riskTags.length > 0 ? RISK_TAGS_BONUS : 0;

    const recentlyChangedObserved = workflow.routeHints.some((routeHint) => {
      const page = snapshot.store.pages[routeHint];
      if (!page) return false;
      const changedMs = new Date(page.lastChangedAt).getTime();
      // Guard against a future-dated lastChangedAt (clock skew) reading as "recently changed" -
      // a negative (now - changed) would otherwise always satisfy "<= window".
      return changedMs <= nowMs && nowMs - changedMs <= RECENTLY_CHANGED_WINDOW_MS;
    });
    const recentlyChanged = recentlyChangedObserved ? RECENTLY_CHANGED_BONUS : 0;

    const score = coverageGap + qaFailures + securityFindings + riskTags + recentlyChanged;

    ranked.push({
      key: workflow.key,
      name: workflow.name,
      score,
      breakdown: { coverageGap, qaFailures, securityFindings, riskTags, recentlyChanged },
      coveragePercent: workflow.coveragePercent,
      routeHints: workflow.routeHints,
      riskTags: workflow.riskTags,
    });
  }

  // Ties broken by workflow name, ascending - deterministic regardless of Object entry order.
  ranked.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.name.localeCompare(b.name)));

  const limited = typeof opts?.topN === "number" ? ranked.slice(0, opts.topN) : ranked;

  return { ranked: limited, unrankable };
}

/**
 * Ticket AP.3's query-param helpers. Live here (not inline in index.ts) so their edge cases
 * are unit-testable without a Fastify test harness - index.ts calls app.listen() at module
 * scope, so it can never be safely imported from a test.
 */
const DEFAULT_TOP_N = 20;

/** Integer 1-100; missing/non-numeric/non-integer (e.g. "1.5")/out-of-range all fall back to
 * the default, 20 - never an error, per Ticket AP.1's pinned bounds. */
export function parseTopN(raw: unknown): number {
  if (typeof raw !== "string" || !/^-?\d+$/.test(raw)) return DEFAULT_TOP_N;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 100) return DEFAULT_TOP_N;
  return n;
}

const ISO_TIMESTAMP_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

/** Must be a complete ISO-8601 timestamp with an explicit timezone/offset - deliberately
 * stricter than Date.parse()/`new Date()`, which also accepts several non-ISO and
 * timezone-less formats that would make AP.4's certification non-reproducible across
 * machines/timezones. */
export function isValidAsOf(raw: string): boolean {
  return ISO_TIMESTAMP_WITH_OFFSET.test(raw) && !Number.isNaN(new Date(raw).getTime());
}
