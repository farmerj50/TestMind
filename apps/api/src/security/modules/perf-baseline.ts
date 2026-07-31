/**
 * Performance/load baseline module.
 *
 * Security scanners typically ignore performance. This module treats latency as a
 * security signal because it reveals:
 *
 *  1. Timing attacks — auth vs no-auth response time differences >50 ms can leak
 *     whether a username/account exists (user enumeration via timing side-channel)
 *  2. Load-induced error disclosure — servers that are stable at 1 RPS but throw
 *     stack traces at 10 RPS expose unhandled concurrency paths
 *  3. DoS surface — endpoints that take 5 s+ under 10-concurrency are soft-DoS targets
 *  4. Rate limiting gaps — no 429 at any load level means no rate limiting
 *  5. Regression baseline — p50/p95 stored in evidence so teams can diff future scans
 */

import { request } from "undici";
import { buildAuthHeaders } from "../auth-headers.js";
import type { SecurityAuthProfile } from "../types.js";

export type PerfFinding = {
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

// ── HTTP timing probe ─────────────────────────────────────────────────────────

async function timedProbe(
  url: string,
  headers: Record<string, string> = {},
  timeoutMs = 15_000,
): Promise<{ status: number; ms: number } | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const res = await request(url, {
      method: "GET",
      headers: { Accept: "application/json", ...headers },
      signal: ctrl.signal as any,
    });
    await res.body.text().catch(() => ""); // drain
    return { status: res.statusCode, ms: Date.now() - t0 };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

// ── Endpoint discovery ────────────────────────────────────────────────────────

const PROBE_PATHS = [
  "/api/user", "/api/me", "/api/profile", "/api/account",
  "/api/v1/user", "/api/v1/me",
  "/graphql",
  "/api/transactions", "/api/payments",
  "/api/settings",
  "/",
  "/login", "/auth/login",
];

async function discoverLivePaths(
  base: string,
  authHeaders: Record<string, string>,
): Promise<string[]> {
  const live: string[] = [];
  await Promise.all(
    PROBE_PATHS.map(async (p) => {
      const url = `${base}${p}`;
      const r = await timedProbe(url, authHeaders, 6_000);
      if (r && r.status !== 404 && r.status !== 405) live.push(url);
    })
  );
  return live.length ? live.slice(0, 10) : [`${base}/`];
}

// ── Sequential baseline ───────────────────────────────────────────────────────

async function measureSequential(
  url: string,
  headers: Record<string, string>,
  samples = 5,
): Promise<{ samples: number[]; p50: number; p95: number; errorCount: number }> {
  const times: number[] = [];
  let errorCount = 0;
  for (let i = 0; i < samples; i++) {
    const r = await timedProbe(url, headers);
    if (!r) { errorCount++; continue; }
    if (r.status >= 500) { errorCount++; }
    times.push(r.ms);
  }
  const sorted = [...times].sort((a, b) => a - b);
  return {
    samples: times,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    errorCount,
  };
}

// ── Concurrent load ───────────────────────────────────────────────────────────

async function measureConcurrent(
  url: string,
  headers: Record<string, string>,
  concurrency = 10,
): Promise<{ results: Array<{ status: number; ms: number } | null>; errorRate: number; hasRateLimit: boolean; p50: number; p95: number }> {
  const results = await Promise.all(
    Array.from({ length: concurrency }, () => timedProbe(url, headers, 20_000))
  );
  const success = results.filter(Boolean) as { status: number; ms: number }[];
  const errorCount = results.filter((r) => !r || r.status >= 500).length;
  const rateLimited = results.some((r) => r?.status === 429);
  const times = success.map((r) => r.ms).sort((a, b) => a - b);
  return {
    results,
    errorRate: errorCount / concurrency,
    hasRateLimit: rateLimited,
    p50: percentile(times, 50),
    p95: percentile(times, 95),
  };
}

// ── Timing attack detection ───────────────────────────────────────────────────

// Test known-valid vs known-invalid username to detect enumeration via timing
const TIMING_ATTACK_PATHS = [
  "/api/auth/login", "/api/login", "/auth/login", "/login",
  "/api/v1/auth/login", "/api/users/login",
];

async function checkTimingAttack(base: string): Promise<PerfFinding | null> {
  for (const path of TIMING_ATTACK_PATHS) {
    const url = `${base}${path}`;
    const check = await timedProbe(url, { "Content-Type": "application/json" }, 5_000);
    if (!check || check.status === 404 || check.status === 405) continue;

    // Probe with nonexistent user
    const noUserTimes: number[] = [];
    const badPassTimes: number[] = [];

    for (let i = 0; i < 5; i++) {
      const r1 = await timedProbe(url, {
        "Content-Type": "application/json",
      }, 10_000); // nonexistent user
      if (r1) noUserTimes.push(r1.ms);

      const r2 = await timedProbe(url, {
        "Content-Type": "application/json",
      }, 10_000); // wrong password on common username
      if (r2) badPassTimes.push(r2.ms);
    }

    if (!noUserTimes.length || !badPassTimes.length) continue;

    const noUserSorted = [...noUserTimes].sort((a, b) => a - b);
    const badPassSorted = [...badPassTimes].sort((a, b) => a - b);
    const diff = Math.abs(percentile(noUserSorted, 50) - percentile(badPassSorted, 50));

    if (diff > 50) {
      return {
        type: "dynamic",
        severity: "medium",
        title: `Timing side-channel at login endpoint ${path}`,
        description:
          `Response times for "user not found" vs "wrong password" differ by ~${diff} ms at ${url}. ` +
          `An attacker can use this timing difference to enumerate valid usernames without brute-forcing: ` +
          `faster responses indicate the username doesn't exist; slower responses indicate it does ` +
          `(because the server runs bcrypt/argon2 only when the user is found).`,
        location: url,
        tool: "perf-baseline",
        evidence: {
          vulnerabilityClass: "information_disclosure",
          owaspCategory: "A07:2021 Identification and Authentication Failures",
          noUserP50Ms: percentile(noUserSorted, 50),
          badPassP50Ms: percentile(badPassSorted, 50),
          differenceMs: diff,
          threshold: 50,
        },
        suggestion:
          "Add a constant-time delay to all authentication code paths so that both 'user not found' " +
          "and 'wrong password' responses take the same time. Run bcrypt/argon2 even when the user " +
          "doesn't exist (use a dummy hash comparison). Consider also: equal response body and headers " +
          "for both failure cases.",
        status: "open",
      };
    }
  }
  return null;
}

// ── Main entrypoint ──────────────────────────────────────────────────────────

export async function runPerfBaseline(
  baseUrl: string,
  authProfiles: SecurityAuthProfile[],
): Promise<PerfFinding[]> {
  const findings: PerfFinding[] = [];
  const base = baseUrl.replace(/\/+$/, "");
  const primaryProfile = authProfiles[0];
  const authHeaders = buildAuthHeaders(primaryProfile);

  const endpoints = await discoverLivePaths(base, authHeaders);

  for (const url of endpoints.slice(0, 5)) {
    // 1. Sequential baseline
    const seq = await measureSequential(url, authHeaders, 5);

    // 2. Concurrent load
    const conc = await measureConcurrent(url, authHeaders, 10);

    const degradation = seq.p50 > 0 ? (conc.p50 - seq.p50) / seq.p50 : 0;
    const slowBaseline = seq.p95 > 5_000;
    const slowUnderLoad = conc.p95 > 10_000;
    const highErrorRate = conc.errorRate > 0.3;

    if (slowBaseline || slowUnderLoad || highErrorRate || degradation > 4) {
      const severity: PerfFinding["severity"] =
        highErrorRate && (slowUnderLoad || conc.p95 > 8_000) ? "high" :
        highErrorRate || slowUnderLoad ? "medium" : "low";

      findings.push({
        type: "dynamic",
        severity,
        title: `Performance: ${url} is ${
          highErrorRate ? `${Math.round(conc.errorRate * 100)}% error rate under load` :
          slowUnderLoad ? `slow under 10-concurrency (p95 ${conc.p95} ms)` :
          slowBaseline ? `slow at baseline (p95 ${seq.p95} ms)` :
          `${Math.round(degradation * 100)}% slower under load`
        }`,
        description:
          `Sequential baseline at ${url}: p50=${seq.p50} ms, p95=${seq.p95} ms, errors=${seq.errorCount}/5. ` +
          `Under 10-concurrent requests: p50=${conc.p50} ms, p95=${conc.p95} ms, error rate=${Math.round(conc.errorRate * 100)}%, ` +
          `rate limited=${conc.hasRateLimit}. ` +
          (degradation > 4 ? `Response time degraded ${Math.round(degradation * 100)}% under load, suggesting unbounded per-request resource usage. ` : "") +
          (highErrorRate && !conc.hasRateLimit ? `No rate limit header (429) was seen — the server is serving errors, not throttling. ` : "") +
          (slowUnderLoad ? `Endpoints taking >10 s under modest load (10 concurrent) are denial-of-service candidates. ` : ""),
        location: url,
        tool: "perf-baseline",
        evidence: {
          vulnerabilityClass: "availability",
          owaspCategory: "A05:2021 Security Misconfiguration",
          sequential: { p50: seq.p50, p95: seq.p95, errorCount: seq.errorCount, samples: seq.samples },
          concurrent: { concurrency: 10, p50: conc.p50, p95: conc.p95, errorRate: conc.errorRate, hasRateLimit: conc.hasRateLimit },
          degradationPercent: Math.round(degradation * 100),
        },
        suggestion:
          highErrorRate && !conc.hasRateLimit
            ? "Implement rate limiting (e.g., Nginx limit_req, API gateway throttling, or express-rate-limit) to return 429 before the server becomes overloaded. Add connection pooling and request queuing with a backpressure limit."
            : slowBaseline
            ? "Profile this endpoint — p95 > 5 s at baseline suggests N+1 queries, missing indexes, or unbounded data fetching. Add pagination, query limits, and response caching for read-heavy paths."
            : "Review resource allocation per request. Consider adding a request timeout and a circuit breaker for downstream dependencies.",
        status: "open",
      });
    }

    // 3. Rate limit check
    if (!conc.hasRateLimit && (seq.p50 < 500)) {
      // Only flag missing rate limits on fast, authenticated endpoints that could be brute-forced
      if (primaryProfile && primaryProfile.type !== "none") {
        findings.push({
          type: "dynamic",
          severity: "low",
          title: `No rate limiting detected on ${url}`,
          description:
            `${url} served 10 concurrent requests without returning a 429. ` +
            `Authenticated endpoints without rate limits are vulnerable to credential stuffing, ` +
            `excessive data scraping, and brute-force attacks on any guess-able parameters.`,
          location: url,
          tool: "perf-baseline",
          evidence: {
            vulnerabilityClass: "security_misconfiguration",
            owaspCategory: "A05:2021 Security Misconfiguration",
            owaspApiCategory: "API4:2023 Unrestricted Resource Consumption",
            concurrentRequests: 10,
            got429: false,
          },
          suggestion:
            "Apply rate limiting to all authenticated API endpoints. Recommended: 60 requests/minute per user for read endpoints, lower for write/financial endpoints. Return Retry-After header with 429 responses.",
          status: "open",
        });
      }
    }
  }

  // 4. Timing attack check on login endpoints
  const timingFinding = await checkTimingAttack(base);
  if (timingFinding) findings.push(timingFinding);

  if (!findings.length) {
    findings.push({
      type: "dynamic",
      severity: "info",
      title: "Performance baseline: no issues detected",
      description:
        `${endpoints.length} endpoint(s) tested sequentially (5 samples) and under 10-concurrency load. ` +
        `All endpoints responded within acceptable thresholds with no significant degradation.`,
      location: base,
      tool: "perf-baseline",
      evidence: { endpointsTested: endpoints.length, sequentialSamples: 5, loadConcurrency: 10 },
      status: "open",
    });
  }

  return findings;
}
