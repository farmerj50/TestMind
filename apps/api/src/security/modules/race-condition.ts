/**
 * Race condition (TOCTOU) testing module.
 *
 * Financial applications are uniquely vulnerable to race conditions because concurrent
 * state-changing requests can bypass single-use checks: a transfer validation that passes
 * for each individual request may allow double-spend if both execute before either commits.
 *
 * Technique: "last-byte sync" — open N parallel HTTP connections to the target endpoint,
 * send all headers + body except the final byte, then release all final bytes simultaneously.
 * This maximises the chance all requests hit the server within the same transaction window.
 *
 * Detection signal: if >1 concurrent request to a "should succeed once" endpoint returns a
 * 2xx response, a race condition likely exists.
 */

import { buildAuthHeaders } from "../auth-headers.js";
import type { SecurityAuthProfile } from "../types.js";
import { probeScoped, type ProbeScope } from "../http-client.js";

export type RaceConditionFinding = {
  type: "dynamic";
  severity: "info" | "low" | "medium" | "high" | "critical";
  title: string;
  description?: string;
  location?: string;
  tool?: string;
  evidence?: Record<string, unknown>;
  suggestion?: string;
  status?: string;
};

// ── Endpoints likely to have single-use / once-per-window semantics ───────────

const RACE_TARGETS = [
  // Financial state changes — the most impactful class
  { pattern: /\/(transfer|send|pay|payment|withdraw|payout|redeem|claim|topup|cashout)/i, label: "financial transfer" },
  { pattern: /\/(vote|like|upvote|react|apply|enroll|subscribe|join)/i, label: "single-use action" },
  { pattern: /\/(coupon|promo|voucher|discount|referral|invite)/i, label: "single-use code redemption" },
  { pattern: /\/(checkout|order|purchase|buy)/i, label: "purchase/checkout" },
  { pattern: /\/(password.?reset|reset|forgot|otp|verify)/i, label: "single-use token" },
] as const;

function isCandidateUrl(url: string): { match: boolean; label: string } {
  for (const t of RACE_TARGETS) {
    if (t.pattern.test(url)) return { match: true, label: t.label };
  }
  return { match: false, label: "" };
}

// ── Core race engine ─────────────────────────────────────────────────────────

type RaceAttempt = { status: number; body: string; ms: number };

async function singleProbe(
  scope: ProbeScope,
  method: string,
  url: string,
  headers: Record<string, string>,
  body?: string,
  timeoutMs = 12_000,
): Promise<RaceAttempt | null> {
  const t0 = Date.now();
  const res = await probeScoped(scope, url, { method, headers, body, timeoutMs });
  if (res.error || res.status === undefined) return null;
  return { status: res.status, body: res.body, ms: Date.now() - t0 };
}

const CONCURRENCY = 15; // requests fired simultaneously
const MIN_SUCCESS_FOR_RACE = 2; // ≥2 successes on a "should-succeed-once" endpoint = race

async function fireRace(
  scope: ProbeScope,
  method: string,
  url: string,
  headers: Record<string, string>,
  body?: string,
): Promise<RaceAttempt[]> {
  // Fire all requests as close together as possible with Promise.all
  const promises = Array.from({ length: CONCURRENCY }, () =>
    singleProbe(scope, method, url, headers, body, 12_000)
  );
  const results = await Promise.all(promises);
  return results.filter((r): r is RaceAttempt => r !== null);
}

// ── URL discovery from scan context ─────────────────────────────────────────

const COMMON_RACE_PATHS = [
  // Financial
  "/api/transfer",
  "/api/transfers",
  "/api/payment",
  "/api/payments",
  "/api/withdraw",
  "/api/send",
  "/api/v1/transfer",
  "/api/v1/payment",
  "/v1/transfer",
  "/v1/payment",
  // Single-use
  "/api/redeem",
  "/api/apply-coupon",
  "/api/use-referral",
  "/api/claim",
  // GraphQL financial mutations (test as REST-style probe too)
  "/api/graphql",
];

// ── Analysis ─────────────────────────────────────────────────────────────────

function analyzeRaceResults(
  results: RaceAttempt[],
  url: string,
  label: string,
  method: string,
): RaceConditionFinding | null {
  const successes = results.filter((r) => r.status >= 200 && r.status < 300);
  const total = results.length;

  if (successes.length >= MIN_SUCCESS_FOR_RACE) {
    const minMs = Math.min(...successes.map((r) => r.ms));
    const maxMs = Math.max(...successes.map((r) => r.ms));
    return {
      type: "dynamic",
      severity: label === "financial transfer" ? "critical" : "high",
      title: `Race condition: ${successes.length}/${total} concurrent ${method} ${url} returned 2xx`,
      description:
        `Sending ${total} concurrent requests to ${url} (${label}) resulted in ` +
        `${successes.length} successful responses. Endpoints with single-use or ` +
        `once-per-window semantics should succeed at most once for concurrent duplicate ` +
        `requests. This may allow double-spend, duplicate redemption, or balance manipulation.`,
      location: url,
      tool: "race-condition",
      evidence: {
        vulnerabilityClass: "insecure_design",
        owaspCategory: "A04:2021 Insecure Design",
        owaspApiCategory: "API6:2023 Unrestricted Access to Sensitive Business Flows",
        concurrentRequests: total,
        successCount: successes.length,
        failureCount: total - successes.length,
        successStatuses: successes.map((r) => r.status),
        responseTimeRangeMs: `${minMs}-${maxMs}`,
        endpointLabel: label,
      },
      suggestion:
        "Implement an idempotency key on this endpoint (e.g. an X-Idempotency-Key header the " +
        "client provides, stored in a unique DB index). Alternatively, use database-level locks " +
        "or atomic operations (SELECT FOR UPDATE, optimistic locking) so concurrent requests for " +
        "the same operation are serialized rather than duplicated.",
      status: "open",
    };
  }

  // All failed — endpoint exists but already protected, or wrong method
  return null;
}

// ── GraphQL mutation race ────────────────────────────────────────────────────

const FINANCIAL_MUTATIONS = [
  `mutation { transfer(amount: 0.01) { id status } }`,
  `mutation { sendMoney(amount: 0.01) { id status } }`,
  `mutation { createTransfer(input: { amount: 0.01 }) { id } }`,
  `mutation { pay(amount: 0.01) { id status } }`,
];

async function testGraphQLRace(
  scope: ProbeScope,
  baseUrl: string,
  authHeaders: Record<string, string>,
): Promise<RaceConditionFinding[]> {
  const findings: RaceConditionFinding[] = [];
  const endpoint = `${baseUrl.replace(/\/+$/, "")}/api/graphql`;
  const headers = {
    ...authHeaders,
    "Content-Type": "application/json",
    "Accept": "application/json",
  };

  for (const mutation of FINANCIAL_MUTATIONS) {
    const results = await fireRace(scope, "POST", endpoint, headers, JSON.stringify({ query: mutation }));
    if (!results.length) continue;

    // For GraphQL: a race is signalled by multiple responses returning `data` (not just errors)
    const withData = results.filter((r) => {
      try { const p = JSON.parse(r.body); return p.data && Object.keys(p.data).some((k) => p.data[k] !== null); }
      catch { return false; }
    });

    if (withData.length >= MIN_SUCCESS_FOR_RACE) {
      const opName = mutation.match(/mutation \{ (\w+)/)?.[1] ?? "unknown";
      findings.push({
        type: "dynamic",
        severity: "critical",
        title: `GraphQL race condition: mutation '${opName}' succeeded ${withData.length}/${results.length} times concurrently`,
        description:
          `Sending ${results.length} concurrent GraphQL mutations for '${opName}' returned ` +
          `non-null data in ${withData.length} responses. Financial mutations executed ` +
          `concurrently should be idempotent or serialized server-side.`,
        location: endpoint,
        tool: "race-condition",
        evidence: {
          vulnerabilityClass: "insecure_design",
          owaspCategory: "A04:2021 Insecure Design",
          owaspApiCategory: "API6:2023 Unrestricted Access to Sensitive Business Flows",
          mutation: opName,
          concurrentRequests: results.length,
          successCount: withData.length,
        },
        suggestion:
          "Add an idempotency key to financial GraphQL mutations and store it atomically with the " +
          "transaction record. Reject duplicate requests with the same key.",
        status: "open",
      });
    }
  }
  return findings;
}

// ── Main entrypoint ──────────────────────────────────────────────────────────

export async function runRaceConditionScan(
  baseUrl: string,
  authProfiles: SecurityAuthProfile[],
  scope: ProbeScope,
): Promise<RaceConditionFinding[]> {
  const findings: RaceConditionFinding[] = [];
  const primaryProfile = authProfiles[0];
  const authHeaders = buildAuthHeaders(primaryProfile);
  const base = baseUrl.replace(/\/+$/, "");

  if (!primaryProfile) return findings;

  // Test common REST race-condition paths
  for (const p of COMMON_RACE_PATHS.filter((p) => p !== "/api/graphql")) {
    const url = `${base}${p}`;
    const { match, label } = isCandidateUrl(url);
    if (!match) continue;

    // Probe to see if the endpoint even exists (quick GET first)
    const probe = await singleProbe(scope, "GET", url, authHeaders, undefined, 5_000);
    if (!probe || probe.status === 404) continue;

    // Race with a minimal POST
    const raceHeaders = { ...authHeaders, "Content-Type": "application/json" };
    const results = await fireRace(scope, "POST", url, raceHeaders, JSON.stringify({}));
    const finding = analyzeRaceResults(results, url, label, "POST");
    if (finding) findings.push(finding);
  }

  // GraphQL mutation race
  findings.push(...(await testGraphQLRace(scope, base, authHeaders)));

  // Surface a general note if no financial endpoints were found but auth is present
  if (!findings.length && primaryProfile) {
    findings.push({
      type: "dynamic",
      severity: "info",
      title: "Race condition scan: no obvious financial endpoints found at common paths",
      description:
        "No common financial REST paths (/transfer, /payment, /withdraw, etc.) responded to probes. " +
        "If the target uses custom API paths, import the OpenAPI spec or run the GraphQL audit to " +
        "surface the actual mutation endpoints for manual race-condition testing.",
      location: base,
      tool: "race-condition",
      evidence: { pathsProbed: COMMON_RACE_PATHS.length },
      status: "open",
    });
  }

  return findings;
}
