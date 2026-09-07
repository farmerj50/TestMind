import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams, Link } from "react-router-dom";
import { useApi, apiUrl } from "../lib/api";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { LiveBrowserView } from "../components/security/LiveBrowserView";

// Live Security Testing v0.1 (POC). A person drives a real, already-authenticated browser
// session; captured GET baselines can be replayed, and GET URLs with server-detected
// resource IDs can be manually mutated. The server still owns all request lookup,
// scope checks, and candidate validation.

type PresetScanIntensity = "human" | "careful" | "standard" | "aggressive";
type ScanIntensity = PresetScanIntensity | "custom";

type TrafficControlState = {
  intensity: ScanIntensity;
  maxActiveTests: number;
  concurrency: number;
  dispatchDelayMs: number;
  adaptiveThrottling: boolean;
  respectRetryAfter: boolean;
  pauseOnSustainedRateLimit: boolean;
};

const VIEWPORT = { width: 1280, height: 800 };
const SECURITY_TEST_CONCURRENCY = 3;
const RECONNECT_DELAYS_MS = [1000, 2000, 5000, 10000, 15000, 30000];
const TERMINAL_CLOSE_CODES = new Set([1000, 1001, 4003, 4004]);
const MAX_SECURITY_TEST_CONCURRENCY = 20;
const HUMAN_PACE_DELAY_MS = 5_000;
const MAX_DISPATCH_DELAY_MS = 60_000;
const AUTOMATED_SCAN_STEP_LIMIT = 100;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_PAUSE_THRESHOLD = 5;
const RATE_LIMIT_STATUSES = new Set([429, 503, 509, 529]);
const MAX_RETAINED_EXCHANGES = 500;
const MAX_SECURITY_CANDIDATE_EXCHANGES = 5_000;
const MAX_RETAINED_SECURITY_TESTS = 5_000;
const MAX_SEEN_EXCHANGE_IDS = 10_000;
const MAX_CLIENT_BODY_CHARS = 64_000;
const MAX_CLIENT_POST_DATA_CHARS = 32_000;
const STALE_EXCHANGE_ERROR_RE = /unknown exchange\b.*scrolled out of the buffer/i;
const VOLATILE_SECURITY_QUERY_PARAM_RE =
  /^(client[_-]?request[_-]?id|request[_-]?id|trace[_-]?id|correlation[_-]?id|cache[_-]?bust|cachebuster|nonce|timestamp|ts|t|_|cb|rand|random)$/i;
const INTENSITY_PRESETS: Record<PresetScanIntensity, Pick<TrafficControlState, "concurrency" | "dispatchDelayMs" | "maxActiveTests">> = {
  human: { concurrency: 1, dispatchDelayMs: HUMAN_PACE_DELAY_MS, maxActiveTests: 0 },
  careful: { concurrency: 1, dispatchDelayMs: 1000, maxActiveTests: 500 },
  standard: { concurrency: SECURITY_TEST_CONCURRENCY, dispatchDelayMs: 250, maxActiveTests: 0 },
  aggressive: { concurrency: SECURITY_TEST_CONCURRENCY, dispatchDelayMs: 0, maxActiveTests: 0 },
};
const INTENSITY_OPTIONS: Array<{ value: PresetScanIntensity; label: string }> = [
  { value: "human", label: "Human pace" },
  { value: "careful", label: "Careful" },
  { value: "standard", label: "Standard" },
  { value: "aggressive", label: "Aggressive" },
];
const DEFAULT_TRAFFIC_CONTROL: TrafficControlState = {
  intensity: "human",
  maxActiveTests: 0,
  concurrency: 1,
  dispatchDelayMs: HUMAN_PACE_DELAY_MS,
  adaptiveThrottling: true,
  respectRetryAfter: true,
  pauseOnSustainedRateLimit: true,
};
const EMPTY_TRAFFIC_TOTALS: LiveTrafficTotals = {
  apiCount: 0,
  securityCandidateCount: 0,
  testableCount: 0,
  responseIdHintCount: 0,
  authenticated: 0,
  stateChangingCount: 0,
};

type ResourceIdCandidate = { location: "path" | "query"; paramName: string; value: string };
type ResponseIdHint = { path: string; value: string };
type ExperimentKind = "replay" | "mutation";

type SecurityHttpExchange = {
  id: string;
  sessionId: string;
  timestamp: number;
  request: { method: string; url: string; headers: Record<string, string>; postData?: string };
  response?: { status: number; headers: Record<string, string>; body?: string; durationMs: number };
  correlatedActionId?: string;
};

type ExchangeDiff = {
  statusMatch: boolean;
  baselineStatus?: number;
  mutatedStatus?: number;
  bodyLengthDelta: number;
  addedKeys: string[];
  removedKeys: string[];
  changedKeys: string[];
};

type ExperimentState =
  | { status: "idle" }
  | { status: "running"; kind: ExperimentKind }
  | { status: "done"; kind: ExperimentKind; mutatedStatus?: number; mutatedBody?: string; diff: ExchangeDiff }
  | { status: "error"; kind?: ExperimentKind; error: string };

type LiveSecurityCheck = {
  id: string;
  title: string;
  status: "passed" | "failed" | "skipped" | "info";
  severity: "info" | "low" | "medium" | "high" | "critical";
  vulnerabilityClass: string;
  owaspCategory: string;
  owaspApiCategory?: string;
  description: string;
  evidence?: Record<string, unknown>;
  validation?: LiveSecurityValidation;
};

type SecurityValidationStatus =
  | "confirmed"
  | "likely"
  | "suspected"
  | "inconclusive"
  | "not_exploitable"
  | "false_positive"
  | "not_applicable";

type LiveSecurityValidationRequirement = {
  id: string;
  label: string;
  passed: boolean | null;
};

type LiveSecurityValidation = {
  status: SecurityValidationStatus;
  confidence: number;
  proofLevel: "passive" | "protocol" | "browser" | "cross_identity" | "repeated";
  attempts: number;
  successfulReproductions: number;
  requirements: LiveSecurityValidationRequirement[];
  expectedBehavior: string;
  observedBehavior: string;
  conclusion: string;
};

type LiveSecurityProbe = {
  label: string;
  result: {
    method?: string;
    status?: number;
    url: string;
    headers?: Record<string, string>;
    bodyLength?: number;
    bodySnippet?: string;
    error?: string;
    browserReadable?: boolean;
    browserBlocked?: boolean;
    browserSkipped?: boolean;
    browserOrigin?: string;
  };
  diff?: ExchangeDiff;
};

type LiveSecurityTestResult = {
  exchangeId: string;
  targetUrl: string;
  checks: LiveSecurityCheck[];
  probes: LiveSecurityProbe[];
  idsFound: number;
  derivedUrls: string[];
  sensitiveDataStopped?: boolean;
  // Ticket TRC.1/TRC.3: each check's supporting probe(s), computed server-side by
  // findSupportingProbes so the reproduction traceability panel below reads a single source of
  // truth instead of re-implementing the correlation logic here.
  supportingProbesByCheckId?: Record<string, LiveSecurityProbe[]>;
};

type SecurityTestState =
  | { status: "running" }
  | { status: "done"; result: LiveSecurityTestResult }
  | { status: "error"; error: string };

type LiveTrafficTotals = {
  apiCount: number;
  securityCandidateCount: number;
  testableCount: number;
  responseIdHintCount: number;
  authenticated: number;
  stateChangingCount: number;
};

type ActionableFindingSummary = {
  exchangeId: string;
  result: LiveSecurityTestResult;
  check: LiveSecurityCheck;
};

type TrafficFilter = "api" | "all";

type SiteWalkState = {
  status: "idle" | "running" | "visiting" | "done" | "failed" | "stopped" | "paused";
  visited: number;
  limit: number;
  url?: string;
  action?: string;
  error?: string;
};

type LiveScope = {
  allowedHosts: string[];
  allowedPorts: number[];
  observedHosts: string[];
};

// Same shape http-exchange.ts's detectResourceIdCandidates produces — kept in sync manually
// since the frontend can't import the backend module directly. Any drift here only affects
// which candidates the UI *offers*; the server independently re-validates every mutation
// against its own detection, so a stale/wrong client-side copy can never widen what's
// actually allowed to execute.
function looksLikeIdValue(value: string) {
  return (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ||
    /^c[a-z0-9]{24,}$/i.test(value) ||
    /^\d{2,}$/.test(value)
  );
}

function hostnameFromUrl(url: string) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function pathnameFromUrl(url: string) {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

function isHostAllowed(host: string, allowedHosts: string[]) {
  if (!host) return false;
  if (allowedHosts.length === 0) return false;
  return allowedHosts.some((allowed) => {
    const normalized = allowed.toLowerCase();
    return host === normalized || host.endsWith(`.${normalized}`);
  });
}

function isApiLikeUrl(url: string) {
  try {
    const parsed = new URL(url);
    return /\/(api|graphql|rest|rpc|v\d+)\b/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

function isStaticAssetUrl(url: string) {
  try {
    const parsed = new URL(url);
    return /\.(?:css|js|mjs|map|png|jpe?g|gif|webp|svg|ico|woff2?|ttf)$/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

function hasAuthHeaders(headers: Record<string, string>) {
  return Object.keys(headers).some((key) =>
    /^(authorization|cookie|x-csrf-token|x-xsrf-token|x-api-key|api-key|x-auth-token|x-session|x-session-id)$/i.test(key)
  );
}

function headerValue(headers: Record<string, string> | undefined, name: string) {
  if (!headers) return "";
  return Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1] ?? "";
}

function looksJson(body: string | undefined) {
  const trimmed = body?.trim() ?? "";
  return (trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"));
}

function truncateClientText(value: string | undefined, maxChars: number): string | undefined {
  if (value === undefined) return undefined;
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n...[truncated ${value.length - maxChars} chars in live view]`;
}

function compactClientExchange(exchange: SecurityHttpExchange): SecurityHttpExchange {
  return {
    ...exchange,
    request: {
      ...exchange.request,
      postData: truncateClientText(exchange.request.postData, MAX_CLIENT_POST_DATA_CHARS),
    },
    response: exchange.response
      ? {
          ...exchange.response,
          body: truncateClientText(exchange.response.body, MAX_CLIENT_BODY_CHARS),
        }
      : undefined,
  };
}

function isJsonResponse(exchange: SecurityHttpExchange) {
  const contentType = headerValue(exchange.response?.headers, "content-type");
  return /\bapplication\/(?:json|[\w.+-]+\+json)\b/i.test(contentType) || looksJson(exchange.response?.body);
}

function isPotentialSecurityTestTarget(exchange: SecurityHttpExchange) {
  return Boolean(exchange.response) && !isStaticAssetUrl(exchange.request.url) && (isApiLikeUrl(exchange.request.url) || isJsonResponse(exchange));
}

function isSecurityTestTarget(exchange: SecurityHttpExchange, allowedHosts: string[]) {
  return (
    isPotentialSecurityTestTarget(exchange) &&
    isHostAllowed(hostnameFromUrl(exchange.request.url), allowedHosts)
  );
}

function newestExchangeFirst(a: SecurityHttpExchange, b: SecurityHttpExchange) {
  return b.timestamp - a.timestamp;
}

function securityTargetKey(exchange: SecurityHttpExchange) {
  try {
    const url = new URL(exchange.request.url);
    for (const key of [...url.searchParams.keys()]) {
      if (VOLATILE_SECURITY_QUERY_PARAM_RE.test(key)) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    return `${exchange.request.method.toUpperCase()} ${url.origin}${url.pathname}${url.search}`;
  } catch {
    return `${exchange.request.method.toUpperCase()} ${exchange.request.url}`;
  }
}

function representativePendingSecurityTargets(targets: SecurityHttpExchange[], securityTests: Record<string, SecurityTestState>) {
  const testedKeys = new Set<string>();
  for (const target of targets) {
    const state = securityTests[target.id];
    if (state && !(state.status === "error" && STALE_EXCHANGE_ERROR_RE.test(state.error))) {
      testedKeys.add(securityTargetKey(target));
    }
  }

  const selectedKeys = new Set(testedKeys);
  const selected: SecurityHttpExchange[] = [];
  for (const target of [...targets].sort(newestExchangeFirst)) {
    const key = securityTargetKey(target);
    if (selectedKeys.has(key)) continue;
    selectedKeys.add(key);
    selected.push(target);
  }
  return selected;
}

function exhaustivePendingSecurityTargets(targets: SecurityHttpExchange[], securityTests: Record<string, SecurityTestState>) {
  return targets.filter((target) => {
    const state = securityTests[target.id];
    return !state || (state.status === "error" && STALE_EXCHANGE_ERROR_RE.test(state.error));
  });
}

function pendingSecurityTargetsForIntensity(
  targets: SecurityHttpExchange[],
  securityTests: Record<string, SecurityTestState>,
  intensity: ScanIntensity
) {
  if (intensity === "human" || intensity === "aggressive" || intensity === "custom") {
    return exhaustivePendingSecurityTargets(targets, securityTests);
  }
  return representativePendingSecurityTargets(targets, securityTests);
}

function countsTowardActiveTestBudget(test: SecurityTestState) {
  return !(test.status === "error" && STALE_EXCHANGE_ERROR_RE.test(test.error));
}

function isRateLimitedStatus(status: number | undefined) {
  return typeof status === "number" && RATE_LIMIT_STATUSES.has(status);
}

function clampNumber(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function parseControlNumber(value: string, fallback: number, min: number, max: number) {
  if (value.trim() === "") return fallback;
  return clampNumber(Number(value), min, max);
}

function parseRetryAfterMs(value: string | undefined) {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return clampNumber(seconds * 1000, 0, MAX_DISPATCH_DELAY_MS);
  const dateMs = Date.parse(value);
  if (Number.isFinite(dateMs)) return clampNumber(dateMs - Date.now(), 0, MAX_DISPATCH_DELAY_MS);
  return 0;
}

function rateLimitHitsFromResult(result: LiveSecurityTestResult) {
  return result.probes.filter((probe) => isRateLimitedStatus(probe.result.status)).length;
}

function retryAfterMsFromResult(result: LiveSecurityTestResult) {
  return result.probes.reduce((maxMs, probe) => {
    const headers = probe.result.headers ?? {};
    const retryAfter = Object.entries(headers).find(([key]) => key.toLowerCase() === "retry-after")?.[1];
    return Math.max(maxMs, parseRetryAfterMs(retryAfter));
  }, 0);
}

function rateLabel(delayMs: number) {
  if (delayMs <= 0) return "burst";
  if (delayMs >= 1000) {
    const seconds = delayMs / 1000;
    return `1 per ${Number.isInteger(seconds) ? seconds.toFixed(0) : seconds.toFixed(1)}s`;
  }
  const perSecond = 1000 / delayMs;
  return `${perSecond >= 10 ? perSecond.toFixed(0) : perSecond.toFixed(1)} tests/s`;
}

function securityCheckClass(check: LiveSecurityCheck) {
  if (check.validation?.status === "confirmed") return "border-rose-200 bg-rose-50 text-rose-800";
  if (check.validation?.status === "likely") return "border-amber-200 bg-amber-50 text-amber-900";
  if (check.validation?.status === "suspected") return "border-orange-200 bg-orange-50 text-orange-900";
  if (check.validation?.status === "not_exploitable" || check.validation?.status === "false_positive") {
    return "border-slate-200 bg-slate-50 text-slate-700";
  }
  if (check.status === "failed") return "border-rose-200 bg-rose-50 text-rose-800";
  if (check.status === "passed") return "border-emerald-200 bg-emerald-50 text-emerald-800";
  if (check.status === "skipped") return "border-slate-200 bg-slate-50 text-slate-600";
  return "border-blue-200 bg-blue-50 text-blue-800";
}

function securityStatusBadgeClass(check: LiveSecurityCheck) {
  if (check.validation?.status === "confirmed") return "bg-rose-700 text-white";
  if (check.validation?.status === "likely") return "bg-amber-700 text-white";
  if (check.validation?.status === "suspected") return "bg-orange-700 text-white";
  if (check.validation?.status === "not_exploitable" || check.validation?.status === "false_positive") return "bg-slate-700 text-white";
  if (check.status === "failed") return "bg-rose-700 text-white";
  if (check.status === "passed") return "bg-emerald-700 text-white";
  if (check.status === "skipped") return "bg-slate-700 text-white";
  return "bg-blue-700 text-white";
}

function validationStatusBadgeClass(status: SecurityValidationStatus) {
  if (status === "confirmed") return "bg-rose-800 text-white";
  if (status === "likely") return "bg-amber-700 text-white";
  if (status === "suspected") return "bg-orange-700 text-white";
  if (status === "not_exploitable") return "bg-slate-700 text-white";
  if (status === "false_positive") return "bg-slate-700 text-white";
  if (status === "not_applicable") return "bg-slate-600 text-white";
  return "bg-blue-800 text-white";
}

function validationRequirementClass(passed: boolean | null) {
  if (passed === true) return "border-emerald-300 bg-white text-emerald-800";
  if (passed === false) return "border-rose-300 bg-white text-rose-800";
  return "border-slate-300 bg-white text-slate-700";
}

function InlineSpinner({ className = "" }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-r-transparent ${className}`}
    />
  );
}

function compactSecurityLabel(value: string) {
  return value.replace(/_/g, " ");
}

function validationLabel(status: SecurityValidationStatus) {
  return compactSecurityLabel(status).toUpperCase();
}

function securityStatusLabel(check: LiveSecurityCheck) {
  if (check.validation?.status === "not_exploitable") return "not exploitable";
  if (check.validation?.status === "confirmed") return "confirmed";
  if (check.validation?.status === "likely") return "likely";
  if (check.validation?.status === "suspected") return "suspected";
  return check.status;
}

function securitySeverityLabel(check: LiveSecurityCheck) {
  if (check.validation?.status === "suspected") return `potential ${check.severity}`;
  if (check.validation?.status === "not_exploitable") return "info";
  return check.severity;
}

function isActionableFinding(check: LiveSecurityCheck) {
  if (check.status !== "failed") return false;
  return !check.validation || check.validation.status === "confirmed";
}

function securityTestHasActionableFinding(test: SecurityTestState) {
  return test.status === "done" && test.result.checks.some(isActionableFinding);
}

function validationRequirementState(passed: boolean | null) {
  if (passed === true) return "PASS";
  if (passed === false) return "FAIL";
  return "N/A";
}

function formatEvidenceValue(key: string, value: unknown) {
  if (value === undefined || value === null || value === "") return "none";
  if (key === "url" && typeof value === "string") return pathnameFromUrl(value);
  if (key === "removedHeaders" && Array.isArray(value)) return `${value.length} removed`;
  if (Array.isArray(value)) {
    if (value.length === 0) return "none";
    if (value.every((item) => typeof item === "string" || typeof item === "number")) {
      const shown = value.slice(0, 3).join(", ");
      return value.length > 3 ? `${shown}, +${value.length - 3}` : shown;
    }
    return `${value.length} item${value.length === 1 ? "" : "s"}`;
  }
  if (typeof value === "object") return `${Object.keys(value as Record<string, unknown>).length} fields`;
  if (typeof value === "string" && /^https?:\/\//i.test(value)) return pathnameFromUrl(value);
  const text = String(value);
  return text.length > 72 ? `${text.slice(0, 69)}...` : text;
}

function compactEvidence(evidence: Record<string, unknown> | undefined) {
  if (!evidence) return [];
  const preferred = [
    "route",
    "method",
    "routeKind",
    "baselineStatus",
    "status",
    "authStatus",
    "unauthStatus",
    "idsFound",
    "urlIds",
    "jsonKeys",
    "authHeaderCount",
    "removedHeaders",
    "accessControlAllowOrigin",
    "accessControlAllowCredentials",
    "potentialSeverity",
    "browserOrigin",
    "browserReadable",
    "url",
    "probeCount",
    "sameData",
    "error",
  ];
  const used = new Set(preferred);
  const entries = preferred
    .filter((key) => Object.prototype.hasOwnProperty.call(evidence, key))
    .map((key) => [key, evidence[key]] as const);
  const extras = Object.entries(evidence)
    .filter(([key]) => !used.has(key))
    .slice(0, 3);
  return [...entries, ...extras].filter(([, value]) => value !== undefined).slice(0, 8);
}

// Reproduction traceability, Ticket TRC.3. Evidence-first, not prose-first: baseline captured
// request -> exact active probe(s) (from the backend's supportingProbesByCheckId, Ticket TRC.1
// - a single source of truth, never re-guessed here) -> observed outcome -> a short generated
// replay note. Never shows a full request/response body, headers are already redacted by
// clientExchange()/the same probeEvidence() truncation every check's evidence already uses -
// this panel only reads what's already safe to display, it doesn't decide safety itself.
function ReproductionTraceabilityPanel({
  exchange,
  supportingProbes,
}: {
  exchange: SecurityHttpExchange;
  supportingProbes: LiveSecurityProbe[];
}) {
  const baselineStatus = exchange.response?.status ?? "no response";
  return (
    <div className="mt-1 rounded border border-slate-300 bg-white p-1.5 text-[11px] text-slate-800 shadow-sm">
      <div className="font-semibold text-slate-950">Reproduction traceability</div>
      <div className="mt-1">
        <span className="font-medium">Baseline:</span>{" "}
        <code>
          {exchange.request.method} {pathnameFromUrl(exchange.request.url)}
        </code>{" "}
        → {baselineStatus}
      </div>
      {supportingProbes.length === 0 ? (
        <div className="mt-1 text-slate-500">No specific probe could be correlated to this finding.</div>
      ) : (
        supportingProbes.map((probe, i) => (
          <div key={i} className="mt-1">
            <span className="font-medium">Probe ({probe.label}):</span>{" "}
            <code>
              {probe.result.method ?? "GET"} {pathnameFromUrl(probe.result.url)}
            </code>{" "}
            → {probe.result.status ?? "no response"}
            {probe.result.bodySnippet && (
              <div className="mt-0.5 text-slate-500">
                Body preview truncated: <code>{probe.result.bodySnippet}</code>
              </div>
            )}
          </div>
        ))
      )}
      <div className="mt-1 text-slate-500">
        To reproduce: replay the request(s) above using your own authenticated test session. Auth
        credentials are redacted here by design and are never shown.
      </div>
    </div>
  );
}

function countValidationStatuses(checks: LiveSecurityCheck[]) {
  return checks.reduce(
    (counts, check) => {
      const status = check.validation?.status;
      if (status === "confirmed") counts.confirmed += 1;
      if (status === "likely") counts.likely += 1;
      if (status === "suspected") counts.suspected += 1;
      if (status === "not_exploitable") counts.notExploitable += 1;
      return counts;
    },
    { confirmed: 0, likely: 0, suspected: 0, notExploitable: 0 }
  );
}

function liveCheckDisplayRank(check: LiveSecurityCheck) {
  const id = check.id.toLowerCase();
  if (isActionableFinding(check)) return 0;
  if (id.includes("unauthenticated") || id.includes("broken-auth")) return 1;
  if (id.includes("idor") || id.includes("alternate-id") || id.includes("derived-detail")) return 2;
  if (id.includes("xss") || id.includes("reflection")) return 3;
  if (id.includes("injection") || id.includes("benign-query")) return 4;
  if (id.includes("method") || id.includes("head")) return 5;
  if (id.includes("cors")) return 6;
  if (id.includes("sensitive") || id.includes("error-disclosure")) return 7;
  if (id === "route-context") return 20;
  return 10;
}

function orderLiveChecksForDisplay(checks: LiveSecurityCheck[]) {
  return [...checks].sort((a, b) => {
    const rankDelta = liveCheckDisplayRank(a) - liveCheckDisplayRank(b);
    if (rankDelta !== 0) return rankDelta;
    return a.title.localeCompare(b.title);
  });
}

function extractResponseIdHints(body: string | undefined, limit = 8): ResponseIdHint[] {
  if (!body) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }

  const hints: ResponseIdHint[] = [];
  const visit = (value: unknown, path: string) => {
    if (hints.length >= limit) return;
    if (Array.isArray(value)) {
      value.slice(0, 8).forEach((item, index) => visit(item, `${path}[${index}]`));
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (hints.length >= limit) return;
      const childPath = path ? `${path}.${key}` : key;
      if ((typeof child === "string" || typeof child === "number") && /(^id$|id$|_id$|uuid|guid)$/i.test(key)) {
        const stringValue = String(child);
        if (looksLikeIdValue(stringValue)) {
          hints.push({ path: childPath, value: stringValue });
          continue;
        }
      }
      visit(child, childPath);
    }
  };

  visit(parsed, "");
  return hints;
}

function analyzeTraffic(exchanges: SecurityHttpExchange[], allowedHosts: string[]) {
  const apiExchanges = exchanges.filter((exchange) => isApiLikeUrl(exchange.request.url));
  const responseIdHints = exchanges.flatMap((exchange) =>
    extractResponseIdHints(exchange.response?.body, 4).map((hint) => ({
      ...hint,
      exchange,
    }))
  );
  const testable = exchanges.filter(
    (exchange) =>
      exchange.request.method.toUpperCase() === "GET" &&
      Boolean(exchange.response) &&
      detectResourceIdCandidates(exchange.request.url).length > 0 &&
      isHostAllowed(hostnameFromUrl(exchange.request.url), allowedHosts)
  );
  const securityTestable = exchanges.filter((exchange) => isSecurityTestTarget(exchange, allowedHosts));
  const outOfScopeHosts = Array.from(
    new Set(
      apiExchanges
        .map((exchange) => hostnameFromUrl(exchange.request.url))
        .filter((host) => host && !isHostAllowed(host, allowedHosts))
    )
  );
  const authenticated = exchanges.filter((exchange) => hasAuthHeaders(exchange.request.headers)).length;
  const stateChanging = exchanges.filter((exchange) => !["GET", "HEAD", "OPTIONS"].includes(exchange.request.method.toUpperCase()));

  return {
    total: exchanges.length,
    apiCount: apiExchanges.length,
    securityTestableCount: securityTestable.length,
    testableCount: testable.length,
    responseIdHints,
    outOfScopeHosts,
    authenticated,
    stateChangingCount: stateChanging.length,
  };
}

function addExchangeToTrafficTotals(current: LiveTrafficTotals, exchange: SecurityHttpExchange): LiveTrafficTotals {
  const method = exchange.request.method.toUpperCase();
  return {
    apiCount: current.apiCount + (isApiLikeUrl(exchange.request.url) ? 1 : 0),
    securityCandidateCount: current.securityCandidateCount + (isPotentialSecurityTestTarget(exchange) ? 1 : 0),
    testableCount:
      current.testableCount +
      (method === "GET" && Boolean(exchange.response) && detectResourceIdCandidates(exchange.request.url).length > 0 ? 1 : 0),
    responseIdHintCount: current.responseIdHintCount + extractResponseIdHints(exchange.response?.body, 4).length,
    authenticated: current.authenticated + (hasAuthHeaders(exchange.request.headers) ? 1 : 0),
    stateChangingCount: current.stateChangingCount + (!["GET", "HEAD", "OPTIONS"].includes(method) ? 1 : 0),
  };
}

function detectResourceIdCandidates(url: string): ResourceIdCandidate[] {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return [];
  }
  const candidates: ResourceIdCandidate[] = [];
  parsed.pathname
    .split("/")
    .filter(Boolean)
    .forEach((segment, index) => {
      if (looksLikeIdValue(segment)) candidates.push({ location: "path", paramName: `segment${index}`, value: segment });
    });
  for (const [key, value] of parsed.searchParams.entries()) {
    if (looksLikeIdValue(value)) candidates.push({ location: "query", paramName: key, value });
  }
  return candidates;
}

export default function LiveSecurityTestPage() {
  const { apiFetch } = useApi();
  const [searchParams] = useSearchParams();
  const authSessionId = searchParams.get("authSessionId") ?? "";

  const [connecting, setConnecting] = useState(false);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exchanges, setExchanges] = useState<SecurityHttpExchange[]>([]);
  const [securityCandidateExchanges, setSecurityCandidateExchanges] = useState<SecurityHttpExchange[]>([]);
  const [capturedExchangeTotal, setCapturedExchangeTotal] = useState(0);
  const [trafficTotals, setTrafficTotals] = useState<LiveTrafficTotals>(EMPTY_TRAFFIC_TOTALS);
  const [experiments, setExperiments] = useState<Record<string, ExperimentState>>({});
  const [securityTests, setSecurityTests] = useState<Record<string, SecurityTestState>>({});
  const [mutationInputs, setMutationInputs] = useState<Record<string, string>>({});
  const [scope, setScope] = useState<LiveScope>({ allowedHosts: [], allowedPorts: [], observedHosts: [] });
  const [trafficFilter, setTrafficFilter] = useState<TrafficFilter>("api");
  const [autoSecurityTesting, setAutoSecurityTesting] = useState(true);
  const [siteWalk, setSiteWalk] = useState<SiteWalkState>({ status: "idle", visited: 0, limit: AUTOMATED_SCAN_STEP_LIMIT });
  const [reconnectAttempt, setReconnectAttempt] = useState(0);
  const [sessionStopped, setSessionStopped] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [activeTestingPaused, setActiveTestingPaused] = useState(false);
  const [activeTestingPauseReason, setActiveTestingPauseReason] = useState<string | null>(null);
  const [trafficControl, setTrafficControl] = useState<TrafficControlState>(DEFAULT_TRAFFIC_CONTROL);
  const [adaptiveDelayMs, setAdaptiveDelayMs] = useState(0);
  const [rateLimitHitCount, setRateLimitHitCount] = useState(0);
  const [securityQueueTick, setSecurityQueueTick] = useState(0);

  const wsRef = useRef<WebSocket | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const seenExchangeIdsRef = useRef<Set<string>>(new Set());
  const reconnectTimerRef = useRef<number | null>(null);
  const securityQueueTimerRef = useRef<number | null>(null);
  const lastSecurityDispatchAtRef = useRef(0);
  const trafficControlRef = useRef<TrafficControlState>(DEFAULT_TRAFFIC_CONTROL);
  const rateLimitWindowRef = useRef<number[]>([]);
  const stoppedRef = useRef(false);
  const analysis = useMemo(() => analyzeTraffic(exchanges, scope.allowedHosts), [exchanges, scope.allowedHosts]);
  // Findings requiring review (below) shows traceability inline rather than only in the deeper
  // per-request list, so a triager reading the top summary never has to go hunting for it.
  // exchanges is capped at MAX_RETAINED_EXCHANGES and can evict an older finding's baseline
  // request out of memory during a long session - lookups against this map degrade gracefully
  // (ReproductionTraceabilityPanel is simply not rendered) rather than throwing.
  const exchangesById = useMemo(() => new Map(exchanges.map((exchange) => [exchange.id, exchange])), [exchanges]);
  const capturedTrafficTotal = Math.max(capturedExchangeTotal, exchanges.length);
  const securityTestTargets = useMemo(
    () => securityCandidateExchanges.filter((exchange) => isSecurityTestTarget(exchange, scope.allowedHosts)),
    [securityCandidateExchanges, scope.allowedHosts]
  );
  const scopeBlockedSecurityHosts = useMemo(
    () =>
      Array.from(
        new Set(
          securityCandidateExchanges
            .map((exchange) => hostnameFromUrl(exchange.request.url))
            .filter((host) => host && !isHostAllowed(host, scope.allowedHosts))
        )
      ).sort(),
    [securityCandidateExchanges, scope.allowedHosts]
  );
  const pendingSecurityTestTargets = useMemo(
    () => pendingSecurityTargetsForIntensity(securityTestTargets, securityTests, trafficControl.intensity),
    [securityTestTargets, securityTests, trafficControl.intensity]
  );
  const visibleExchanges = useMemo(
    () => (trafficFilter === "api" ? exchanges.filter((exchange) => isApiLikeUrl(exchange.request.url) || isJsonResponse(exchange)) : exchanges),
    [exchanges, trafficFilter]
  );
  const runningSecurityTests = Object.values(securityTests).filter((test) => test.status === "running").length;
  const completedSecurityTests = Object.values(securityTests).filter((test) => test.status === "done").length;
  const startedSecurityTests = Object.values(securityTests).filter(countsTowardActiveTestBudget).length;
  const actionableFindings = useMemo<ActionableFindingSummary[]>(
    () =>
      Object.entries(securityTests).flatMap(([exchangeId, test]) =>
        test.status === "done"
          ? test.result.checks.filter(isActionableFinding).map((check) => ({ exchangeId, result: test.result, check }))
          : []
      ),
    [securityTests]
  );
  const securityTestAttempts = useMemo(
    () =>
      Object.entries(securityTests).flatMap(([exchangeId, test]) =>
        test.status === "done" || test.status === "error" ? [{ exchangeId, test }] : []
      ),
    [securityTests]
  );
  const recentSecurityTestAttempts = useMemo(
    () => securityTestAttempts.slice(-25).reverse(),
    [securityTestAttempts]
  );
  const erroredSecurityTests = securityTestAttempts.filter(({ test }) => test.status === "error").length;
  const failedSecurityChecks = actionableFindings.length;
  const siteWalkActive = siteWalk.status === "running" || siteWalk.status === "visiting";
  const activeTestingBlocked = sessionStopped || activeTestingPaused;
  const maxActiveTests = Math.max(0, trafficControl.maxActiveTests);
  const maxActiveReached = maxActiveTests > 0 && startedSecurityTests >= maxActiveTests;
  const pendingSecurityTests = sessionStopped ? 0 : pendingSecurityTestTargets.length;
  const scopeBlockedSecurityCandidateCount = scopeBlockedSecurityHosts.length === 0 ? 0 : securityCandidateExchanges.length - securityTestTargets.length;
  const singleBlockedSecurityHost = scopeBlockedSecurityHosts.length === 1 ? scopeBlockedSecurityHosts[0] : null;
  const dispatchablePendingSecurityTests = activeTestingBlocked || maxActiveReached ? 0 : pendingSecurityTests;
  const securityTestingActive = !activeTestingBlocked && runningSecurityTests > 0;
  const capturedApiActionDisabled =
    !connected || sessionStopped || (dispatchablePendingSecurityTests === 0 && !singleBlockedSecurityHost);
  const effectiveDispatchDelayMs = trafficControl.adaptiveThrottling
    ? Math.max(trafficControl.dispatchDelayMs, adaptiveDelayMs)
    : trafficControl.dispatchDelayMs;
  const capturedRateLimitResponses = exchanges.filter((exchange) => isRateLimitedStatus(exchange.response?.status)).length;
  const probeRateLimitResponses = Object.values(securityTests).reduce(
    (count, test) => count + (test.status === "done" ? rateLimitHitsFromResult(test.result) : 0),
    0
  );
  const rateLimitedResponses = capturedRateLimitResponses + probeRateLimitResponses;
  const stopAvailable = Boolean(authSessionId) && !sessionStopped;

  function sendInput(payload: Record<string, unknown>) {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
  }

  function routeWalkDelayMs(control: TrafficControlState, adaptiveMs = adaptiveDelayMs) {
    return control.adaptiveThrottling ? Math.max(control.dispatchDelayMs, adaptiveMs) : control.dispatchDelayMs;
  }

  function sendAutomationPacing(control: TrafficControlState = trafficControlRef.current, adaptiveMs = adaptiveDelayMs) {
    sendInput({ type: "automationPacing", dispatchDelayMs: routeWalkDelayMs(control, adaptiveMs) });
  }

  function clearReconnectTimer() {
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }

  function clearSecurityQueueTimer() {
    if (securityQueueTimerRef.current !== null) {
      window.clearTimeout(securityQueueTimerRef.current);
      securityQueueTimerRef.current = null;
    }
  }

  function scheduleSecurityQueue(delayMs: number) {
    if (securityQueueTimerRef.current !== null || sessionStopped || activeTestingPaused || stoppedRef.current) return;
    securityQueueTimerRef.current = window.setTimeout(() => {
      securityQueueTimerRef.current = null;
      setSecurityQueueTick((tick) => tick + 1);
    }, Math.max(0, delayMs));
  }

  function registerSecurityResult(result: LiveSecurityTestResult) {
    if (!trafficControlRef.current.adaptiveThrottling) return;
    const hits = rateLimitHitsFromResult(result);
    if (hits === 0) {
      setAdaptiveDelayMs((current) => (current > 0 ? Math.max(0, Math.floor(current * 0.7) - 100) : 0));
      return;
    }

    const now = Date.now();
    rateLimitWindowRef.current = [
      ...rateLimitWindowRef.current.filter((timestamp) => now - timestamp <= RATE_LIMIT_WINDOW_MS),
      ...Array.from({ length: hits }, () => now),
    ];
    setRateLimitHitCount((current) => current + hits);

    const retryAfterMs = trafficControlRef.current.respectRetryAfter ? retryAfterMsFromResult(result) : 0;
    setAdaptiveDelayMs((current) => {
      const doubled = current > 0 ? current * 2 : 1000;
      return clampNumber(Math.max(doubled, retryAfterMs), 1000, MAX_DISPATCH_DELAY_MS);
    });

    if (trafficControlRef.current.pauseOnSustainedRateLimit && rateLimitWindowRef.current.length >= RATE_LIMIT_PAUSE_THRESHOLD) {
      const reason = "Paused after sustained 429/503+ responses.";
      setActiveTestingPaused(true);
      setActiveTestingPauseReason(reason);
      setAutoSecurityTesting(false);
      clearSecurityQueueTimer();
      markRunningSecurityTestsPaused(reason);
    }
  }

  function applyIntensity(intensity: PresetScanIntensity) {
    const preset = INTENSITY_PRESETS[intensity];
    const next = { ...trafficControlRef.current, intensity, ...preset };
    setTrafficControl(next);
    sendAutomationPacing(next);
  }

  function pauseActiveTesting() {
    setActiveTestingPaused(true);
    setActiveTestingPauseReason("Paused by user.");
    setAutoSecurityTesting(false);
    clearSecurityQueueTimer();
  }

  function resumeActiveTesting() {
    if (sessionStopped) return;
    setError(null);
    setActiveTestingPaused(false);
    setActiveTestingPauseReason(null);
    setAutoSecurityTesting(true);
  }

  function reduceActiveRate() {
    const current = trafficControlRef.current;
    const next = {
      ...current,
      intensity: "custom" as const,
      concurrency: Math.max(1, current.concurrency - 1),
      dispatchDelayMs:
        current.dispatchDelayMs < HUMAN_PACE_DELAY_MS
          ? HUMAN_PACE_DELAY_MS
          : clampNumber(current.dispatchDelayMs * 2, HUMAN_PACE_DELAY_MS, MAX_DISPATCH_DELAY_MS),
    };
    setTrafficControl(next);
    sendAutomationPacing(next);
  }

  function resetAdaptiveThrottle() {
    rateLimitWindowRef.current = [];
    setAdaptiveDelayMs(0);
    setRateLimitHitCount(0);
    sendAutomationPacing(trafficControlRef.current, 0);
  }

  function markRunningSecurityTestsPaused(reason: string) {
    setSecurityTests((prev) => {
      const next = { ...prev };
      for (const [exchangeId, test] of Object.entries(prev)) {
        if (test.status === "running") next[exchangeId] = { status: "error", error: reason };
      }
      return next;
    });
  }

  useEffect(() => {
    trafficControlRef.current = trafficControl;
  }, [trafficControl]);

  useEffect(() => {
    if (!connected || sessionStopped) return;
    sendAutomationPacing(trafficControl, adaptiveDelayMs);
    // sendAutomationPacing reads only the websocket ref plus the supplied values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, sessionStopped, trafficControl, adaptiveDelayMs]);

  useEffect(() => {
    if (exchanges.length === 0 && securityCandidateExchanges.length === 0) return;
    const retainedIds = new Set([...exchanges, ...securityCandidateExchanges].map((exchange) => exchange.id));
    setSecurityTests((prev) => {
      const entries = Object.entries(prev);
      if (entries.length <= MAX_RETAINED_SECURITY_TESTS) return prev;
      let changed = false;
      const next: Record<string, SecurityTestState> = {};
      for (const [exchangeId, test] of entries) {
        if (retainedIds.has(exchangeId) || test.status === "running" || securityTestHasActionableFinding(test)) {
          next[exchangeId] = test;
        } else {
          changed = true;
        }
      }
      return changed ? next : prev;
    });
    setExperiments((prev) => {
      const entries = Object.entries(prev);
      if (entries.length <= MAX_RETAINED_SECURITY_TESTS) return prev;
      let changed = false;
      const next: Record<string, ExperimentState> = {};
      for (const [exchangeId, experiment] of entries) {
        if (retainedIds.has(exchangeId) || experiment.status === "running") {
          next[exchangeId] = experiment;
        } else {
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [exchanges, securityCandidateExchanges]);

  async function stopSession() {
    stoppedRef.current = true;
    setError(null);
    setSessionStopped(true);
    setStopping(true);
    setAutoSecurityTesting(false);
    clearReconnectTimer();
    clearSecurityQueueTimer();
    sendInput({ type: "stop" });
    wsRef.current?.close(1000, "stopped by user");
    wsRef.current = null;
    setConnected(false);
    setConnecting(false);
    setReconnectAttempt(0);
    setSiteWalk((prev) => (prev.status === "running" || prev.status === "visiting" ? { ...prev, status: "stopped", error: "Stopped by user" } : prev));
    setSecurityTests((prev) => {
      const next = { ...prev };
      for (const [exchangeId, test] of Object.entries(prev)) {
        if (test.status === "running") next[exchangeId] = { status: "error", error: "Stopped by user" };
      }
      return next;
    });
    setExperiments((prev) => {
      const next = { ...prev };
      for (const [exchangeId, experiment] of Object.entries(prev)) {
        if (experiment.status === "running") next[exchangeId] = { status: "error", kind: experiment.kind, error: "Stopped by user" };
      }
      return next;
    });
    try {
      await apiFetch(`/security/auth-sessions/${authSessionId}/live-test-stop`, { method: "POST" });
      setError(null);
    } catch (err: any) {
      setError(err?.message ?? "Failed to stop live session.");
    } finally {
      setStopping(false);
    }
  }

  useEffect(() => {
    if (!authSessionId) return;
    let cancelled = false;
    stoppedRef.current = false;
    setSessionStopped(false);
    setActiveTestingPaused(false);
    setActiveTestingPauseReason(null);
    setAutoSecurityTesting(true);
    setAdaptiveDelayMs(0);
    setRateLimitHitCount(0);
    rateLimitWindowRef.current = [];
    seenExchangeIdsRef.current.clear();
    setCapturedExchangeTotal(0);
    setTrafficTotals(EMPTY_TRAFFIC_TOTALS);
    setExchanges([]);
    setSecurityCandidateExchanges([]);
    setExperiments({});
    setSecurityTests({});
    setMutationInputs({});
    setReconnectAttempt(0);

    function scheduleReconnect(nextAttempt: number, reason: string) {
      if (cancelled || stoppedRef.current) return;
      if (nextAttempt > RECONNECT_DELAYS_MS.length) {
        setError(`${reason} Reconnect attempts exhausted. Refresh the page or return to Security Scan and reopen the session.`);
        setConnecting(false);
        return;
      }
      const delayMs = RECONNECT_DELAYS_MS[nextAttempt - 1] ?? RECONNECT_DELAYS_MS[RECONNECT_DELAYS_MS.length - 1];
      clearReconnectTimer();
      setReconnectAttempt(nextAttempt);
      setConnecting(true);
      setError(`${reason} Reconnecting in ${Math.round(delayMs / 1000)}s...`);
      reconnectTimerRef.current = window.setTimeout(() => {
        reconnectTimerRef.current = null;
        connect(nextAttempt);
      }, delayMs);
    }

    // Ticket 0.5 — UI history recovery. A page reload remounts this component, which resets
    // all the in-memory lists below to empty; this backfills them from the server's durable
    // history (Ticket 0.2/0.3) instead of leaving the view blank until new traffic arrives.
    // Runs in parallel with connect() below, not sequentially before it — hydration failing
    // must not block establishing the live WS connection.
    async function hydrateHistory() {
      try {
        const page = await apiFetch<{ exchanges: SecurityHttpExchange[]; nextCursor: string | null; totalCount: number }>(
          `/security/auth-sessions/${authSessionId}/exchanges?limit=${MAX_RETAINED_EXCHANGES}`
        );
        if (cancelled) return;
        const compacted = page.exchanges.map(compactClientExchange);
        // Snapshot BEFORE mutating the ref: only exchanges not already seen (i.e. not already
        // reflected in trafficTotals by the concurrent WS handler) should be counted below —
        // otherwise an id present in both this hydration page and an already-processed WS
        // message would get double-counted.
        const newlyHydrated = compacted.filter((exchange) => !seenExchangeIdsRef.current.has(exchange.id));
        for (const exchange of compacted) seenExchangeIdsRef.current.add(exchange.id);

        // Merge rather than replace: connect() runs concurrently and may already have
        // delivered live "exchange" messages (via its own functional setExchanges updater)
        // before this fetch resolves — a plain replace here would silently drop them.
        setExchanges((prev) => {
          const extra = prev.filter((exchange) => !compacted.some((c) => c.id === exchange.id));
          const merged = [...compacted, ...extra];
          return merged.length > MAX_RETAINED_EXCHANGES ? merged.slice(-MAX_RETAINED_EXCHANGES) : merged;
        });
        const candidates = compacted.filter(isPotentialSecurityTestTarget);
        setSecurityCandidateExchanges((prev) => {
          const extra = prev.filter((exchange) => !candidates.some((c) => c.id === exchange.id));
          const merged = [...candidates, ...extra];
          return merged.length > MAX_SECURITY_CANDIDATE_EXCHANGES ? merged.slice(-MAX_SECURITY_CANDIDATE_EXCHANGES) : merged;
        });
        setTrafficTotals((current) => newlyHydrated.reduce((acc, exchange) => addExchangeToTrafficTotals(acc, exchange), current));
        // Max, not replace: totalCount reflects the server's count as of when this REST call
        // was made, which could already be stale relative to a few WS increments that landed
        // in the meantime — never let hydration move the displayed total backward.
        setCapturedExchangeTotal((current) => Math.max(current, page.totalCount));

        const observedHosts = new Set<string>();
        for (const exchange of compacted) {
          const host = hostnameFromUrl(exchange.request.url);
          if (host) observedHosts.add(host);
        }
        if (observedHosts.size) {
          setScope((prev) => ({ ...prev, observedHosts: [...new Set([...prev.observedHosts, ...observedHosts])].sort() }));
        }
      } catch (err) {
        console.warn("[LiveSecurityTestPage] failed to hydrate exchange history:", err);
      }
    }

    async function connect(attempt = 0) {
      clearReconnectTimer();
      setConnecting(true);
      if (attempt === 0) setError(null);
      try {
        const res = await apiFetch<{ ticket: string }>(`/security/auth-sessions/${authSessionId}/live-test-ticket`, {
          method: "POST",
        });
        if (cancelled) return;
        const httpBase = apiUrl(`/security/auth-sessions/${authSessionId}/live-test`);
        const wsUrl = `${httpBase.replace(/^http/, "ws")}?ticket=${encodeURIComponent(res.ticket)}`;
        const ws = new WebSocket(wsUrl);
        wsRef.current = ws;

        ws.onopen = () => {
          if (cancelled || stoppedRef.current) {
            ws.close();
            return;
          }
          setConnected(true);
          setConnecting(false);
          setReconnectAttempt(0);
          setError(null);
        };
        ws.onmessage = (evt) => {
          if (stoppedRef.current) return;
          let msg: any;
          try {
            msg = JSON.parse(evt.data);
          } catch {
            return;
          }
          if (msg.type === "frame" && imgRef.current) {
            imgRef.current.src = `data:image/jpeg;base64,${msg.data}`;
          } else if (msg.type === "ready" || msg.type === "scope") {
            setError(null);
            setScope({
              allowedHosts: Array.isArray(msg.allowedHosts) ? msg.allowedHosts : [],
              allowedPorts: Array.isArray(msg.allowedPorts) ? msg.allowedPorts : [],
              observedHosts: Array.isArray(msg.observedHosts) ? msg.observedHosts : [],
            });
          } else if (msg.type === "scopeError") {
            setError(msg.error ?? "Could not update live security scope.");
          } else if (msg.type === "exchange") {
            if (!msg.exchange?.id || !msg.exchange?.request?.url) return;
            const exchange = compactClientExchange(msg.exchange);
            if (seenExchangeIdsRef.current.has(exchange.id)) return;
            seenExchangeIdsRef.current.add(exchange.id);
            while (seenExchangeIdsRef.current.size > MAX_SEEN_EXCHANGE_IDS) {
              const oldest = seenExchangeIdsRef.current.values().next();
              if (oldest.done) break;
              seenExchangeIdsRef.current.delete(oldest.value);
            }
            setCapturedExchangeTotal((count) => count + 1);
            setTrafficTotals((current) => addExchangeToTrafficTotals(current, exchange));
            if (isPotentialSecurityTestTarget(exchange)) {
              setSecurityCandidateExchanges((prev) => {
                const next = [...prev, exchange];
                return next.length > MAX_SECURITY_CANDIDATE_EXCHANGES ? next.slice(-MAX_SECURITY_CANDIDATE_EXCHANGES) : next;
              });
            }
            setExchanges((prev) => {
              const next = [...prev, exchange];
              return next.length > MAX_RETAINED_EXCHANGES ? next.slice(-MAX_RETAINED_EXCHANGES) : next;
            });
            const observedHost = hostnameFromUrl(exchange.request.url);
            if (observedHost) {
              setScope((prev) =>
                prev.observedHosts.includes(observedHost)
                  ? prev
                  : { ...prev, observedHosts: [...prev.observedHosts, observedHost].sort() }
              );
            }
          } else if (msg.type === "experimentResult") {
            setExperiments((prev) => ({
              ...prev,
              [msg.exchangeId]: {
                status: "done",
                kind: msg.experimentKind === "replay" ? "replay" : "mutation",
                mutatedStatus: msg.mutatedResult?.status,
                mutatedBody: msg.mutatedResult?.body,
                diff: msg.diff,
              },
            }));
          } else if (msg.type === "experimentError") {
            setExperiments((prev) => {
              const current = prev[msg.exchangeId];
              return {
                ...prev,
                [msg.exchangeId]: {
                  status: "error",
                  kind: current?.status === "running" ? current.kind : undefined,
                  error: msg.error,
                },
              };
            });
          } else if (msg.type === "securityTestResult") {
            registerSecurityResult(msg.result);
            setSecurityTests((prev) => ({
              ...prev,
              [msg.exchangeId]: { status: "done", result: msg.result },
            }));
          } else if (msg.type === "securityTestError") {
            setSecurityTests((prev) => ({
              ...prev,
              [msg.exchangeId]: { status: "error", error: msg.error ?? "Security test failed" },
            }));
          } else if (msg.type === "rateLimit") {
            const reason = typeof msg.error === "string" ? msg.error : "Rate limit or WAF block detected. Active testing was paused.";
            if (Number.isFinite(msg.dispatchDelayMs)) {
              setAdaptiveDelayMs((current) => Math.max(current, clampNumber(Number(msg.dispatchDelayMs), 0, MAX_DISPATCH_DELAY_MS)));
            }
            setActiveTestingPaused(true);
            setActiveTestingPauseReason(reason);
            setAutoSecurityTesting(false);
            clearSecurityQueueTimer();
            markRunningSecurityTestsPaused(reason);
            setSiteWalk((prev) =>
              prev.status === "running" || prev.status === "visiting" ? { ...prev, status: "paused", error: reason } : prev
            );
            setError(reason);
          } else if (msg.type === "siteWalk") {
            if (msg.pauseActiveTests || msg.rateLimited) {
              const reason =
                typeof msg.error === "string" ? msg.error : "Rate limit or WAF block detected. Active testing was paused.";
              if (Number.isFinite(msg.dispatchDelayMs)) {
                setAdaptiveDelayMs((current) => Math.max(current, clampNumber(Number(msg.dispatchDelayMs), 0, MAX_DISPATCH_DELAY_MS)));
              }
              setActiveTestingPaused(true);
              setActiveTestingPauseReason(reason);
              setAutoSecurityTesting(false);
              clearSecurityQueueTimer();
              markRunningSecurityTestsPaused(reason);
              setError(reason);
            }
            setSiteWalk({
              status: ["running", "visiting", "done", "failed", "stopped", "paused"].includes(msg.status) ? msg.status : "idle",
              visited: Number.isFinite(msg.visited) ? msg.visited : 0,
              limit: Number.isFinite(msg.limit) ? msg.limit : 25,
              url: typeof msg.url === "string" ? msg.url : undefined,
              action: typeof msg.action === "string" ? msg.action : undefined,
              error: typeof msg.error === "string" ? msg.error : undefined,
            });
          } else if (msg.type === "status" && msg.status === "failed") {
            setError(msg.error ?? "Live session failed");
          }
        };
        ws.onerror = () => {
          setConnected(false);
        };
        ws.onclose = (evt) => {
          if (wsRef.current === ws) wsRef.current = null;
          setConnected(false);
          setConnecting(false);
          if (cancelled || stoppedRef.current) return;
          if (TERMINAL_CLOSE_CODES.has(evt.code)) {
            setError(evt.reason || "Live session closed.");
            return;
          }
          scheduleReconnect(attempt + 1, "Live session disconnected.");
        };
      } catch (err: any) {
        if (!cancelled) {
          setConnected(false);
          scheduleReconnect(attempt + 1, err?.message ?? "Failed to start live testing session.");
        }
      }
    }

    hydrateHistory();
    connect();
    return () => {
      cancelled = true;
      clearReconnectTimer();
      clearSecurityQueueTimer();
      wsRef.current?.close();
      wsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authSessionId]);

  function runExperiment(exchange: SecurityHttpExchange, candidate: ResourceIdCandidate) {
    if (!connected || sessionStopped || activeTestingPaused) return;
    const key = `${exchange.id}:${candidate.location}:${candidate.paramName}`;
    const newValue = mutationInputs[key]?.trim();
    if (!newValue) return;
    setExperiments((prev) => ({ ...prev, [exchange.id]: { status: "running", kind: "mutation" } }));
    sendInput({
      type: "mutate",
      exchangeId: exchange.id,
      location: candidate.location,
      paramName: candidate.paramName,
      newValue,
    });
  }

  function runReplay(exchange: SecurityHttpExchange) {
    if (!connected || sessionStopped || activeTestingPaused) return;
    setExperiments((prev) => ({ ...prev, [exchange.id]: { status: "running", kind: "replay" } }));
    sendInput({ type: "replay", exchangeId: exchange.id });
  }

  function queueSecurityTests(targets: SecurityHttpExchange[], rerun = false) {
    if (!connected || sessionStopped || stoppedRef.current) return;
    if (activeTestingPaused) return;
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    const running = Object.values(securityTests).filter((test) => test.status === "running").length;
    const concurrency = clampNumber(trafficControl.concurrency, 1, MAX_SECURITY_TEST_CONCURRENCY);
    const capacity = Math.max(0, concurrency - running);
    if (capacity === 0) return;

    const maxTests = Math.max(0, trafficControl.maxActiveTests);
    const budgetedTests = Object.values(securityTests).filter(countsTowardActiveTestBudget).length;
    const remainingBudget = maxTests > 0 ? maxTests - budgetedTests : Number.POSITIVE_INFINITY;
    if (!rerun && remainingBudget <= 0) return;

    const now = Date.now();
    const dispatchDelay = rerun ? 0 : effectiveDispatchDelayMs;
    const waitMs = dispatchDelay > 0 ? Math.max(0, lastSecurityDispatchAtRef.current + dispatchDelay - now) : 0;
    if (waitMs > 0) {
      scheduleSecurityQueue(waitMs);
      return;
    }

    const batchLimit = rerun
      ? capacity
      : Math.min(capacity, remainingBudget, dispatchDelay > 0 ? 1 : capacity);
    const orderedTargets = rerun ? targets : targets;
    const selected = orderedTargets
      .filter((exchange) => isSecurityTestTarget(exchange, scope.allowedHosts))
      .filter((exchange) => {
        const current = securityTests[exchange.id];
        return rerun ? current?.status !== "running" : !current;
      })
      .slice(0, batchLimit);
    if (selected.length === 0) return;

    setSecurityTests((prev) => {
      const next = { ...prev };
      for (const exchange of selected) next[exchange.id] = { status: "running" };
      return next;
    });
    lastSecurityDispatchAtRef.current = Date.now();
    for (const exchange of selected) sendInput({ type: "securityTest", exchangeId: exchange.id });
  }

  function runSecurityTest(exchange: SecurityHttpExchange) {
    queueSecurityTests([exchange], true);
  }

  function runApiSecurityTests() {
    queueSecurityTests(pendingSecurityTestTargets);
  }

  function runCapturedApiAction() {
    if (dispatchablePendingSecurityTests > 0) {
      runApiSecurityTests();
      return;
    }
    if (singleBlockedSecurityHost) allowHost(singleBlockedSecurityHost, true);
  }

  function startAutomatedScan() {
    if (!connected || sessionStopped) return;
    setError(null);
    setActiveTestingPaused(false);
    setActiveTestingPauseReason(null);
    setAutoSecurityTesting(true);
    if (!siteWalkActive) {
      setSiteWalk({ status: "running", visited: 0, limit: AUTOMATED_SCAN_STEP_LIMIT });
      sendInput({ type: "siteWalk", dispatchDelayMs: routeWalkDelayMs(trafficControlRef.current) });
    }
    setSecurityQueueTick((tick) => tick + 1);
  }

  function allowHost(host: string, runAfter = false) {
    if (!connected || sessionStopped) return;
    sendInput({ type: "allowHost", host });
    setScope((prev) =>
      prev.allowedHosts.includes(host) ? prev : { ...prev, allowedHosts: [...prev.allowedHosts, host].sort() }
    );
    if (runAfter) {
      setError(null);
      setActiveTestingPaused(false);
      setActiveTestingPauseReason(null);
      setAutoSecurityTesting(true);
      setSecurityQueueTick((tick) => tick + 1);
    }
  }

  useEffect(() => {
    if (!autoSecurityTesting || activeTestingPaused || sessionStopped) return;
    queueSecurityTests(pendingSecurityTestTargets);
    // queueSecurityTests intentionally reads the latest state from this render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    autoSecurityTesting,
    activeTestingPaused,
    connected,
    sessionStopped,
    securityQueueTick,
    pendingSecurityTestTargets,
    securityTests,
    scope.allowedHosts,
    trafficControl,
    adaptiveDelayMs,
  ]);

  if (!authSessionId) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-10">
        <p className="text-sm text-slate-600">
          No auth session specified.{" "}
          <Link to="/security-scan" className="text-emerald-600 underline">
            Go back to Security Scan
          </Link>{" "}
          and start a Live Test from a captured External Security Assessment session.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-7xl px-4 py-6">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Live Security Test</h1>
          <p className="text-sm text-slate-600">
            {reconnectAttempt > 0
              ? `Reconnecting (${reconnectAttempt}/${RECONNECT_DELAYS_MS.length})...`
              : connecting
                ? "Connecting..."
                : sessionStopped
                  ? "Stopped"
                  : connected
                  ? "Connected — browse the app normally."
                  : "Disconnected"}
          </p>
        </div>
        <Button type="button" variant="outline" onClick={stopSession} disabled={stopping || !stopAvailable}>
          {stopping ? "Stopping..." : sessionStopped ? "Session stopped" : "Stop session"}
        </Button>
      </div>

      {error && <div className="mb-4 rounded border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div>}

      <Card className="mb-4">
        <CardHeader className="flex flex-row items-center justify-between gap-3">
          <CardTitle className="text-base">Live analysis</CardTitle>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant="default"
              disabled={!connected || sessionStopped || siteWalkActive}
              onClick={startAutomatedScan}
            >
              {siteWalkActive ? "Full automated scan running..." : "Start full automated scan"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant={activeTestingPaused ? "default" : "outline"}
              disabled={sessionStopped}
              onClick={activeTestingPaused ? resumeActiveTesting : pauseActiveTesting}
            >
              {activeTestingPaused ? "Resume active tests" : "Pause active tests"}
            </Button>
            <Button type="button" size="sm" variant="outline" disabled={sessionStopped} onClick={reduceActiveRate}>
              Reduce rate
            </Button>
            <Button type="button" size="sm" disabled={capturedApiActionDisabled} onClick={runCapturedApiAction}>
              <span className="inline-flex items-center gap-1.5">
                {securityTestingActive && <InlineSpinner />}
                {securityTestingActive
                  ? `Running ${runningSecurityTests}`
                  : pendingSecurityTests > 0
                    ? `Test captured APIs (${pendingSecurityTests})`
                    : singleBlockedSecurityHost
                      ? `Authorize and test (${scopeBlockedSecurityCandidateCount})`
                      : scopeBlockedSecurityCandidateCount > 0
                        ? `Choose API host (${scopeBlockedSecurityCandidateCount})`
                      : "Test captured APIs (0)"}
              </span>
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="grid grid-cols-2 gap-2 md:grid-cols-7">
            <div className="rounded border border-slate-200 px-3 py-2">
              <div className="text-xs text-slate-500">Traffic</div>
              <div className="font-semibold text-slate-900">{capturedTrafficTotal}</div>
            </div>
            <div className="rounded border border-slate-200 px-3 py-2">
              <div className="text-xs text-slate-500">API calls</div>
              <div className="font-semibold text-slate-900">{Math.max(trafficTotals.apiCount, analysis.apiCount)}</div>
            </div>
            <div className="rounded border border-slate-200 px-3 py-2">
              <div className="text-xs text-slate-500">Test ready</div>
              <div className="font-semibold text-slate-900">{securityTestTargets.length}</div>
              {scopeBlockedSecurityCandidateCount > 0 && (
                <div className="mt-0.5 text-[11px] text-amber-700">{scopeBlockedSecurityCandidateCount} blocked by scope</div>
              )}
            </div>
            <div className="rounded border border-slate-200 px-3 py-2">
              <div className="text-xs text-slate-500">ID targets</div>
              <div className="font-semibold text-slate-900">{Math.max(trafficTotals.testableCount, analysis.testableCount)}</div>
            </div>
            <div className="rounded border border-slate-200 px-3 py-2">
              <div className="text-xs text-slate-500">JSON IDs</div>
              <div className="font-semibold text-slate-900">{Math.max(trafficTotals.responseIdHintCount, analysis.responseIdHints.length)}</div>
            </div>
            <div className="rounded border border-slate-200 px-3 py-2">
              <div className="text-xs text-slate-500">Auth headers</div>
              <div className="font-semibold text-slate-900">{Math.max(trafficTotals.authenticated, analysis.authenticated)}</div>
            </div>
            <div className="rounded border border-slate-200 px-3 py-2">
              <div className="text-xs text-slate-500">Findings</div>
              <div className={failedSecurityChecks > 0 ? "font-semibold text-rose-600" : "font-semibold text-slate-900"}>
                {failedSecurityChecks}
              </div>
            </div>
          </div>

          <div className="rounded border border-slate-200 bg-slate-50 px-3 py-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="font-medium text-slate-800">Traffic control</div>
                <div className="text-xs text-slate-500">
                  Human pace slows browser walking and active probes; captured traffic is counted continuously.
                </div>
              </div>
              <div className="flex flex-wrap gap-1 text-xs">
                <span className="rounded border border-slate-300 bg-white px-2 py-1 text-slate-700">
                  rate: <code>{rateLabel(effectiveDispatchDelayMs)}</code>
                </span>
                <span className="rounded border border-slate-300 bg-white px-2 py-1 text-slate-700">
                  429/503+: <code>{rateLimitedResponses}</code>
                </span>
                <span className="rounded border border-slate-300 bg-white px-2 py-1 text-slate-700">
                  adaptive: <code>{adaptiveDelayMs}ms</code>
                </span>
                {maxActiveReached && (
                  <span className="rounded border border-amber-300 bg-amber-100 px-2 py-1 text-amber-900">
                    active cap reached
                  </span>
                )}
              </div>
            </div>

            <div className="mt-3 grid gap-3 lg:grid-cols-4">
              <div>
                <div className="mb-1 text-xs font-medium text-slate-700">Intensity</div>
                <div className="inline-flex rounded-md border border-slate-300 bg-white p-0.5">
                  {INTENSITY_OPTIONS.map(({ value, label }) => (
                    <button
                      key={value}
                      type="button"
                      className={`whitespace-nowrap rounded px-2 py-1 text-xs font-medium ${
                        trafficControl.intensity === value ? "bg-blue-600 text-white" : "text-slate-700 hover:bg-slate-100"
                      }`}
                      onClick={() => applyIntensity(value)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {trafficControl.intensity === "custom" && <div className="mt-1 text-[11px] text-slate-500">Custom settings active.</div>}
              </div>

              <label className="space-y-1 text-xs font-medium text-slate-700">
                <span>Max active tests</span>
                <input
                  type="number"
                  min={0}
                  max={100000}
                  value={trafficControl.maxActiveTests}
                  onChange={(e) =>
                    setTrafficControl((current) => ({
                      ...current,
                      intensity: "custom",
                      maxActiveTests: parseControlNumber(e.target.value, current.maxActiveTests, 0, 100000),
                    }))
                  }
                  className="w-full rounded border border-slate-300 bg-white px-2 py-1 text-sm text-slate-900"
                />
                <span className="block text-[11px] font-normal text-slate-500">0 means unlimited.</span>
              </label>

              <label className="space-y-1 text-xs font-medium text-slate-700">
                <span>Concurrency</span>
                <input
                  type="number"
                  min={1}
                  max={MAX_SECURITY_TEST_CONCURRENCY}
                  value={trafficControl.concurrency}
                  onChange={(e) =>
                    setTrafficControl((current) => ({
                      ...current,
                      intensity: "custom",
                      concurrency: parseControlNumber(e.target.value, current.concurrency, 1, MAX_SECURITY_TEST_CONCURRENCY),
                    }))
                  }
                  className="w-full rounded border border-slate-300 bg-white px-2 py-1 text-sm text-slate-900"
                />
              </label>

              <label className="space-y-1 text-xs font-medium text-slate-700">
                <span>Dispatch delay ms</span>
                <input
                  type="number"
                  min={0}
                  max={MAX_DISPATCH_DELAY_MS}
                  step={100}
                  value={trafficControl.dispatchDelayMs}
                  onChange={(e) =>
                    setTrafficControl((current) => ({
                      ...current,
                      intensity: "custom",
                      dispatchDelayMs: parseControlNumber(e.target.value, current.dispatchDelayMs, 0, MAX_DISPATCH_DELAY_MS),
                    }))
                  }
                  className="w-full rounded border border-slate-300 bg-white px-2 py-1 text-sm text-slate-900"
                />
              </label>
            </div>

            <div className="mt-3 flex flex-wrap gap-3 text-xs text-slate-700">
              <label className="inline-flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={trafficControl.adaptiveThrottling}
                  onChange={(e) => setTrafficControl((current) => ({ ...current, adaptiveThrottling: e.target.checked }))}
                />
                Adaptive throttling
              </label>
              <label className="inline-flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={trafficControl.respectRetryAfter}
                  onChange={(e) => setTrafficControl((current) => ({ ...current, respectRetryAfter: e.target.checked }))}
                />
                Respect Retry-After
              </label>
              <label className="inline-flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={trafficControl.pauseOnSustainedRateLimit}
                  onChange={(e) => setTrafficControl((current) => ({ ...current, pauseOnSustainedRateLimit: e.target.checked }))}
                />
                Pause on sustained 429/503+
              </label>
              {(adaptiveDelayMs > 0 || rateLimitHitCount > 0) && (
                <Button type="button" size="sm" variant="outline" onClick={resetAdaptiveThrottle}>
                  Reset throttle
                </Button>
              )}
            </div>
          </div>

          {actionableFindings.length > 0 && (
            <div className="rounded border border-rose-300 bg-rose-50 px-3 py-2 text-rose-900">
              <div className="mb-2 font-medium">Findings requiring review</div>
              <div className="space-y-2">
                {actionableFindings.slice(0, 10).map(({ exchangeId, result, check }) => {
                  const findingExchange = exchangesById.get(exchangeId);
                  return (
                    <div key={`${exchangeId}:${check.id}`} className="rounded border border-rose-200 bg-white px-2 py-1.5 text-xs shadow-sm">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold">{check.title}</span>
                        <span className={`rounded px-1.5 py-0.5 uppercase ${securityStatusBadgeClass(check)}`}>
                          {securityStatusLabel(check)}
                        </span>
                        <span className="rounded border border-slate-300 bg-slate-50 px-1.5 py-0.5 text-slate-800">
                          {securitySeverityLabel(check)}
                        </span>
                        <code className="rounded border border-slate-300 bg-slate-50 px-1.5 py-0.5 text-slate-800">
                          {pathnameFromUrl(result.targetUrl)}
                        </code>
                      </div>
                      <div className="mt-1 text-rose-800">{check.validation?.conclusion ?? check.description}</div>
                      {findingExchange ? (
                        <ReproductionTraceabilityPanel
                          exchange={findingExchange}
                          supportingProbes={result.supportingProbesByCheckId?.[check.id] ?? []}
                        />
                      ) : (
                        <div className="mt-1 text-slate-500">
                          Baseline request detail is no longer retained in this browser session; see Security test results below for the full request/response trail while it is still active, or reload from stored history.
                        </div>
                      )}
                    </div>
                  );
                })}
                {actionableFindings.length > 10 && (
                  <div className="text-xs text-rose-800">Showing 10 of {actionableFindings.length} confirmed findings.</div>
                )}
              </div>
            </div>
          )}

          {(completedSecurityTests > 0 || runningSecurityTests > 0 || pendingSecurityTests > 0) && (
            <div
              className={
                securityTestingActive
                  ? "rounded border border-blue-200 bg-blue-50 px-3 py-2 text-blue-800"
                  : "rounded border border-slate-200 bg-slate-50 px-3 py-2 text-slate-700"
              }
              role={securityTestingActive ? "status" : undefined}
              aria-live="polite"
            >
              <div className="flex items-center gap-2">
                {securityTestingActive && <InlineSpinner className="h-4 w-4" />}
                <span>
                  Automated security tester: {runningSecurityTests} running, {pendingSecurityTests} queued, {completedSecurityTests} completed.
                </span>
              </div>
              {activeTestingPaused && (
                <div className="mt-1 text-xs text-slate-600">
                  {activeTestingPauseReason ?? "Active testing is paused."} Capture and browsing can continue; queued tests stay available.
                </div>
              )}
              {securityTestingActive && (
                <div className="mt-1 text-xs text-blue-700">
                  Active API probes are still running. Results appear in Security test results and on retained request cards.
                </div>
              )}
            </div>
          )}

          {siteWalk.status !== "idle" && (
            <div className="rounded border border-slate-200 bg-slate-50 px-3 py-2 text-slate-700">
              Automated scan: {siteWalk.status} ({siteWalk.visited}/{siteWalk.limit})
              {siteWalk.action ? ` ${siteWalk.action}` : ""}
              {siteWalk.url ? ` ${pathnameFromUrl(siteWalk.url)}` : ""}
              {siteWalk.error ? ` ${siteWalk.error}` : ""}
            </div>
          )}

          {scopeBlockedSecurityHosts.length > 0 && (
            <div className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-amber-900">
              <div className="mb-1 font-medium">Captured API candidates are blocked by scope.</div>
              <div className="mb-2 text-xs">
                {scopeBlockedSecurityCandidateCount} captured API/JSON request
                {scopeBlockedSecurityCandidateCount === 1 ? "" : "s"} can be tested after authorizing the host.
              </div>
              <div className="flex flex-wrap gap-2">
                {scopeBlockedSecurityHosts.map((host) => (
                  <Button key={host} type="button" size="sm" variant="outline" disabled={!connected || sessionStopped} onClick={() => allowHost(host, true)}>
                    Authorize and test {host}
                  </Button>
                ))}
              </div>
            </div>
          )}

          {capturedTrafficTotal > 0 && analysis.testableCount === 0 && (
            <div className="rounded border border-slate-200 bg-slate-50 px-3 py-2 text-slate-700">
              No URL-ID mutation target yet. API security tests can still run on captured API/JSON GET responses.
            </div>
          )}

          {Math.max(trafficTotals.stateChangingCount, analysis.stateChangingCount) > 0 && (
            <div className="rounded border border-slate-200 bg-slate-50 px-3 py-2 text-slate-700">
              State-changing requests were observed, but live active tests only use captured GET baselines.
            </div>
          )}

          {analysis.responseIdHints.length > 0 && (
            <div className="rounded border border-slate-200 px-3 py-2">
              <div className="mb-1 font-medium text-slate-800">Response IDs found</div>
              <div className="space-y-1 text-xs text-slate-600">
                {analysis.responseIdHints.slice(0, 5).map((hint) => (
                  <div key={`${hint.exchange.id}:${hint.path}:${hint.value}`} className="flex items-center gap-2">
                    <span className="truncate">{pathnameFromUrl(hint.exchange.request.url)}</span>
                    <code className="rounded bg-slate-100 px-1">{hint.path}</code>
                    <code className="rounded bg-slate-100 px-1">{hint.value}</code>
                  </div>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {recentSecurityTestAttempts.length > 0 && (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-3">
            <CardTitle className="text-base">
              Security test results ({completedSecurityTests} completed{erroredSecurityTests > 0 ? `, ${erroredSecurityTests} failed` : ""})
            </CardTitle>
            <span className="text-xs text-slate-500">
              Showing latest {recentSecurityTestAttempts.length}
            </span>
          </CardHeader>
          <CardContent className="max-h-[420px] space-y-2 overflow-y-auto">
            {recentSecurityTestAttempts.map(({ exchangeId, test }) => {
              if (test.status === "error") {
                return (
                  <div key={exchangeId} className="rounded border border-rose-200 bg-rose-50 p-2 text-xs text-rose-800">
                    <div className="font-semibold">Security test failed</div>
                    <div className="mt-0.5 break-words">{test.error}</div>
                  </div>
                );
              }
              const result = test.result;
              const failedChecks = result.checks.filter(isActionableFinding);
              const probeCount = result.probes?.length ?? 0;
              const validationCounts = countValidationStatuses(result.checks);
              const primaryChecks = orderLiveChecksForDisplay(result.checks).slice(0, 12);
              return (
                <div key={exchangeId} className="rounded border border-slate-200 bg-slate-50 p-2 text-xs">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={failedChecks.length > 0 ? "font-semibold text-rose-700" : "font-semibold text-emerald-700"}>
                      {failedChecks.length} finding{failedChecks.length === 1 ? "" : "s"}
                    </span>
                    <span className="rounded border border-slate-300 bg-white px-1.5 py-0.5 text-slate-800">
                      {result.checks.length} check{result.checks.length === 1 ? "" : "s"}
                    </span>
                    <span className="rounded border border-slate-300 bg-white px-1.5 py-0.5 text-slate-800">
                      {probeCount} active probe{probeCount === 1 ? "" : "s"}
                    </span>
                    <code className="min-w-0 max-w-full truncate rounded border border-slate-300 bg-white px-1.5 py-0.5 text-slate-800">
                      {pathnameFromUrl(result.targetUrl)}
                    </code>
                  </div>
                  {validationCounts.confirmed + validationCounts.likely + validationCounts.suspected + validationCounts.notExploitable > 0 && (
                    <div className="mt-1 flex flex-wrap gap-1 text-[11px] text-slate-700">
                      <span className="rounded border border-slate-300 bg-white px-1.5 py-0.5">confirmed: {validationCounts.confirmed}</span>
                      <span className="rounded border border-slate-300 bg-white px-1.5 py-0.5">likely: {validationCounts.likely}</span>
                      <span className="rounded border border-slate-300 bg-white px-1.5 py-0.5">suspected: {validationCounts.suspected}</span>
                      <span className="rounded border border-slate-300 bg-white px-1.5 py-0.5">
                        not exploitable: {validationCounts.notExploitable}
                      </span>
                    </div>
                  )}
                  <div className="mt-2 space-y-1">
                    {primaryChecks.map((check) => (
                      <div key={check.id} className={`rounded border px-2 py-1 ${securityCheckClass(check)}`}>
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium">{check.title}</span>
                          <span className={`rounded px-1.5 py-0.5 uppercase ${securityStatusBadgeClass(check)}`}>
                            {securityStatusLabel(check)}
                          </span>
                          <span className="rounded border border-slate-300 bg-white px-1.5 py-0.5 text-slate-800 shadow-sm">
                            {securitySeverityLabel(check)}
                          </span>
                          {check.validation && (
                            <span className={`rounded px-1.5 py-0.5 font-semibold uppercase ${validationStatusBadgeClass(check.validation.status)}`}>
                              {validationLabel(check.validation.status)} {check.validation.confidence}%
                            </span>
                          )}
                        </div>
                        <div className="mt-0.5 text-[11px]">{check.validation?.conclusion ?? check.description}</div>
                      </div>
                    ))}
                    {result.checks.length > primaryChecks.length && (
                      <div className="text-[11px] text-slate-500">
                        {result.checks.length - primaryChecks.length} more check{result.checks.length - primaryChecks.length === 1 ? "" : "s"} on this request
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Browser</CardTitle>
          </CardHeader>
          <CardContent>
            <LiveBrowserView viewport={VIEWPORT} imgRef={imgRef} sendInput={sendInput} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-3">
            <CardTitle className="text-base">
              Captured traffic ({visibleExchanges.length}/{capturedTrafficTotal})
            </CardTitle>
            <div className="flex gap-1">
              <Button
                type="button"
                size="sm"
                variant={trafficFilter === "api" ? "default" : "outline"}
                onClick={() => setTrafficFilter("api")}
              >
                API
              </Button>
              <Button
                type="button"
                size="sm"
                variant={trafficFilter === "all" ? "default" : "outline"}
                onClick={() => setTrafficFilter("all")}
              >
                All
              </Button>
            </div>
          </CardHeader>
          <CardContent className="max-h-[600px] space-y-2 overflow-y-auto">
            {capturedTrafficTotal === 0 && <p className="text-sm text-slate-500">No requests captured yet — browse the app.</p>}
            {capturedTrafficTotal > 0 && visibleExchanges.length === 0 && (
              <p className="text-sm text-slate-500">No API or JSON requests captured yet.</p>
            )}
            {visibleExchanges.map((exchange) => {
              const candidates = detectResourceIdCandidates(exchange.request.url);
              const responseHints = extractResponseIdHints(exchange.response?.body, 3);
              const method = exchange.request.method.toUpperCase();
              const isGet = method === "GET";
              const host = hostnameFromUrl(exchange.request.url);
              const hostAllowed = isHostAllowed(host, scope.allowedHosts);
              const hasResponse = Boolean(exchange.response);
              const experiment = experiments[exchange.id];
              const isRunning = experiment?.status === "running";
              const isReplayRunning = experiment?.status === "running" && experiment.kind === "replay";
              const isMutationRunning = experiment?.status === "running" && experiment.kind === "mutation";
              const replayDisabled = !connected || sessionStopped || activeTestingPaused || !isGet || !hasResponse || !hostAllowed || isRunning;
              const canSecurityTest = isSecurityTestTarget(exchange, scope.allowedHosts);
              const securityTest = securityTests[exchange.id];
              const isSecurityRunning = securityTest?.status === "running";
              const failedChecks = securityTest?.status === "done" ? securityTest.result.checks.filter(isActionableFinding) : [];
              const probeCount = securityTest?.status === "done" ? securityTest.result.probes?.length ?? 0 : 0;
              const validationCounts = securityTest?.status === "done" ? countValidationStatuses(securityTest.result.checks) : null;
              return (
                <div key={exchange.id} className="rounded border border-slate-200 p-2 text-xs">
                  <div className="flex items-center gap-2">
                    <span className="font-mono font-semibold">{exchange.request.method}</span>
                    <span className="truncate text-slate-700">{exchange.request.url}</span>
                    <span
                      className={
                        exchange.response && exchange.response.status < 400 ? "ml-auto text-emerald-600" : "ml-auto text-rose-600"
                      }
                    >
                      {exchange.response?.status ?? "…"}
                    </span>
                  </div>
                  {exchange.correlatedActionId && <div className="mt-1 text-slate-400">triggered by user input</div>}

                  <div className="mt-2 flex flex-wrap gap-1 text-[11px]">
                    {isApiLikeUrl(exchange.request.url) && (
                      <span className="rounded bg-blue-50 px-1.5 py-0.5 text-blue-700">api</span>
                    )}
                    {isStaticAssetUrl(exchange.request.url) && (
                      <span className="rounded bg-slate-100 px-1.5 py-0.5 text-slate-500">static</span>
                    )}
                    {isJsonResponse(exchange) && (
                      <span className="rounded bg-violet-50 px-1.5 py-0.5 text-violet-700">json</span>
                    )}
                    {hasAuthHeaders(exchange.request.headers) && (
                      <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-emerald-700">auth</span>
                    )}
                    {!hostAllowed && host && (
                      <span className="rounded bg-amber-50 px-1.5 py-0.5 text-amber-700">host not authorized</span>
                    )}
                    {!hasResponse && <span className="rounded bg-slate-100 px-1.5 py-0.5 text-slate-500">waiting</span>}
                  </div>

                  {hasResponse && !isStaticAssetUrl(exchange.request.url) && (isApiLikeUrl(exchange.request.url) || isJsonResponse(exchange)) && (
                    <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-dashed border-slate-200 pt-2">
                      <span className="text-slate-500">{isGet ? "Captured GET baseline" : "Captured API response"}</span>
                      <Button
                        type="button"
                        size="sm"
                        disabled={!connected || sessionStopped || activeTestingPaused || !canSecurityTest || isSecurityRunning}
                        onClick={() => runSecurityTest(exchange)}
                      >
                        <span className="inline-flex items-center gap-1.5">
                          {isSecurityRunning && <InlineSpinner />}
                          {isSecurityRunning ? "Running..." : securityTest?.status === "done" ? "Re-run tests" : "Run security tests"}
                        </span>
                      </Button>
                      {isGet && (
                        <Button type="button" size="sm" variant="outline" disabled={replayDisabled} onClick={() => runReplay(exchange)}>
                          {isReplayRunning ? "Replaying..." : "Replay baseline"}
                        </Button>
                      )}
                      {!hostAllowed && host && (
                        <Button type="button" size="sm" variant="outline" disabled={!connected || sessionStopped} onClick={() => allowHost(host)}>
                          Authorize host
                        </Button>
                      )}
                    </div>
                  )}

                  {isGet && hasResponse && isStaticAssetUrl(exchange.request.url) && trafficFilter === "all" && (
                    <div className="mt-2 rounded bg-slate-50 p-2 text-slate-500">Static asset ignored for security tests.</div>
                  )}

                  {isGet &&
                    !isStaticAssetUrl(exchange.request.url) &&
                    candidates.map((candidate) => {
                      const key = `${exchange.id}:${candidate.location}:${candidate.paramName}`;
                      return (
                        <div key={key} className="mt-2 flex items-center gap-2 border-t border-dashed border-slate-200 pt-2">
                          <span className="text-slate-500">
                            {candidate.location} <code>{candidate.paramName}</code> = <code>{candidate.value}</code>
                          </span>
                          <input
                            className="w-24 rounded border border-slate-300 px-1 py-0.5 text-xs"
                            placeholder="new value"
                            value={mutationInputs[key] ?? ""}
                            onChange={(e) => setMutationInputs((prev) => ({ ...prev, [key]: e.target.value }))}
                          />
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={!connected || sessionStopped || activeTestingPaused || !hostAllowed || !mutationInputs[key]?.trim() || isRunning}
                            onClick={() => runExperiment(exchange, candidate)}
                          >
                            {isMutationRunning ? "Testing..." : "Test this ID"}
                          </Button>
                        </div>
                      );
                    })}

                  {isGet && responseHints.length > 0 && candidates.length === 0 && (
                    <div className="mt-2 rounded bg-slate-50 p-2 text-slate-600">
                      IDs were found in the response body, but this request has no URL ID to mutate yet.
                    </div>
                  )}

                  {securityTest?.status === "running" && (
                    <div className="mt-2 flex items-center gap-2 rounded bg-blue-50 p-2 text-blue-700" role="status" aria-live="polite">
                      <InlineSpinner className="h-4 w-4" />
                      <span>Running live API security tests for {pathnameFromUrl(exchange.request.url)}...</span>
                    </div>
                  )}

                  {securityTest?.status === "done" && (
                    <div className="mt-2 space-y-2 rounded bg-slate-50 p-2">
                      <div className={failedChecks.length > 0 ? "font-medium text-rose-700" : "font-medium text-emerald-700"}>
                        Security tests complete: {failedChecks.length} finding{failedChecks.length === 1 ? "" : "s"}, {probeCount} active
                        probe{probeCount === 1 ? "" : "s"}, {securityTest.result.idsFound} response ID
                        {securityTest.result.idsFound === 1 ? "" : "s"}
                        {validationCounts &&
                          validationCounts.confirmed + validationCounts.likely + validationCounts.suspected + validationCounts.notExploitable > 0 &&
                          `, ${validationCounts.confirmed} confirmed, ${validationCounts.likely} likely, ${validationCounts.suspected} suspected, ${validationCounts.notExploitable} not exploitable`}
                      </div>
                      <div className="space-y-1">
                        {securityTest.result.checks.map((check) => {
                          const evidence = compactEvidence(check.evidence);
                          return (
                            <div key={check.id} className={`rounded border px-2 py-1 ${securityCheckClass(check)}`}>
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="font-medium">{check.title}</span>
                                <span className={`rounded px-1.5 py-0.5 uppercase ${securityStatusBadgeClass(check)}`}>
                                  {securityStatusLabel(check)}
                                </span>
                                <span className="rounded border border-slate-300 bg-white px-1.5 py-0.5 text-slate-800 shadow-sm">
                                  {securitySeverityLabel(check)}
                                </span>
                                {check.owaspApiCategory && (
                                  <span className="rounded border border-slate-300 bg-white px-1.5 py-0.5 text-slate-800 shadow-sm">
                                    {check.owaspApiCategory}
                                  </span>
                                )}
                                <span className="rounded border border-slate-300 bg-white px-1.5 py-0.5 text-slate-800 shadow-sm">
                                  {compactSecurityLabel(check.vulnerabilityClass)}
                                </span>
                                {check.validation && (
                                  <span className={`rounded px-1.5 py-0.5 font-semibold uppercase ${validationStatusBadgeClass(check.validation.status)}`}>
                                    {validationLabel(check.validation.status)} {check.validation.confidence}%
                                  </span>
                                )}
                              </div>
                              <div className="mt-0.5 text-[11px]">{check.description}</div>
                              {check.validation && (
                                <div className="mt-1 rounded border border-slate-300 bg-white p-1.5 text-[11px] text-slate-800 shadow-sm">
                                  <div className="min-w-0 break-words">
                                    <span className="font-semibold text-slate-950">Validation:</span> {check.validation.conclusion}
                                  </div>
                                  <div className="mt-1 flex flex-wrap gap-1">
                                    <span className="rounded border border-slate-300 bg-slate-50 px-1.5 py-0.5 text-slate-800">
                                      proof: <code>{compactSecurityLabel(check.validation.proofLevel)}</code>
                                    </span>
                                    <span className="rounded border border-slate-300 bg-slate-50 px-1.5 py-0.5 text-slate-800">
                                      attempts: <code>{check.validation.attempts}</code>
                                    </span>
                                    <span className="rounded border border-slate-300 bg-slate-50 px-1.5 py-0.5 text-slate-800">
                                      reproduced: <code>{check.validation.successfulReproductions}</code>
                                    </span>
                                  </div>
                                  <div className="mt-1 flex flex-wrap gap-1">
                                    {check.validation.requirements.slice(0, 6).map((requirement) => (
                                      <span
                                        key={requirement.id}
                                        className={`rounded border px-1.5 py-0.5 ${validationRequirementClass(requirement.passed)}`}
                                      >
                                        <code className="font-semibold">{validationRequirementState(requirement.passed)}</code>{" "}
                                        {requirement.label}
                                      </span>
                                    ))}
                                  </div>
                                </div>
                              )}
                              {evidence.length > 0 && (
                                <div className="mt-1 flex flex-wrap gap-1 text-[11px] opacity-90">
                                  {evidence.map(([key, value]) => (
                                    <span key={key} className="rounded border border-slate-300 bg-white px-1.5 py-0.5 text-slate-800 shadow-sm">
                                      {compactSecurityLabel(key)}:{" "}
                                      <code className="font-semibold text-slate-950">{formatEvidenceValue(key, value)}</code>
                                    </span>
                                  ))}
                                </div>
                              )}
                              {check.status === "failed" && (
                                <ReproductionTraceabilityPanel
                                  exchange={exchange}
                                  supportingProbes={securityTest.result.supportingProbesByCheckId?.[check.id] ?? []}
                                />
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {securityTest?.status === "error" && (
                    <div className="mt-2 rounded bg-rose-50 p-2 text-rose-700">Security test failed: {securityTest.error}</div>
                  )}

                  {experiment?.status === "done" && (
                    <div className="mt-2 rounded bg-slate-50 p-2">
                      <div>
                        Baseline {exchange.response?.status} -&gt; {experiment.kind === "replay" ? "Replay" : "Mutated"}{" "}
                        {experiment.mutatedStatus}
                        {experiment.diff.statusMatch ? " (same status)" : " (status changed)"}
                      </div>
                      <div>Body length delta: {experiment.diff.bodyLengthDelta}</div>
                      {experiment.diff.changedKeys.length > 0 && <div>Changed keys: {experiment.diff.changedKeys.join(", ")}</div>}
                      {experiment.diff.addedKeys.length > 0 && <div>Added keys: {experiment.diff.addedKeys.join(", ")}</div>}
                      {experiment.diff.removedKeys.length > 0 && <div>Removed keys: {experiment.diff.removedKeys.join(", ")}</div>}
                    </div>
                  )}
                  {experiment?.status === "error" && (
                    <div className="mt-2 rounded bg-rose-50 p-2 text-rose-700">
                      {experiment.kind ? `${experiment.kind === "replay" ? "Replay" : "Mutation"} failed: ` : ""}
                      {experiment.error}
                    </div>
                  )}
                </div>
              );
            })}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
