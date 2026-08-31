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

const VIEWPORT = { width: 1280, height: 800 };
const SECURITY_TEST_CONCURRENCY = 3;

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
};

type LiveSecurityProbe = {
  label: string;
  result: { status?: number; url: string; error?: string };
  diff?: ExchangeDiff;
};

type LiveSecurityTestResult = {
  exchangeId: string;
  targetUrl: string;
  checks: LiveSecurityCheck[];
  probes: LiveSecurityProbe[];
  idsFound: number;
  derivedUrls: string[];
};

type SecurityTestState =
  | { status: "running" }
  | { status: "done"; result: LiveSecurityTestResult }
  | { status: "error"; error: string };

type TrafficFilter = "api" | "all";

type SiteWalkState = {
  status: "idle" | "running" | "visiting" | "done" | "failed";
  visited: number;
  limit: number;
  url?: string;
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

function isJsonResponse(exchange: SecurityHttpExchange) {
  const contentType = headerValue(exchange.response?.headers, "content-type");
  return /\bapplication\/(?:json|[\w.+-]+\+json)\b/i.test(contentType) || looksJson(exchange.response?.body);
}

function isSecurityTestTarget(exchange: SecurityHttpExchange, allowedHosts: string[]) {
  return (
    Boolean(exchange.response) &&
    !isStaticAssetUrl(exchange.request.url) &&
    (isApiLikeUrl(exchange.request.url) || isJsonResponse(exchange)) &&
    isHostAllowed(hostnameFromUrl(exchange.request.url), allowedHosts)
  );
}

function securityCheckClass(status: LiveSecurityCheck["status"]) {
  if (status === "failed") return "border-rose-200 bg-rose-50 text-rose-800";
  if (status === "passed") return "border-emerald-200 bg-emerald-50 text-emerald-800";
  if (status === "skipped") return "border-slate-200 bg-slate-50 text-slate-600";
  return "border-blue-200 bg-blue-50 text-blue-800";
}

function securityStatusBadgeClass(status: LiveSecurityCheck["status"]) {
  if (status === "failed") return "bg-rose-700 text-white";
  if (status === "passed") return "bg-emerald-700 text-white";
  if (status === "skipped") return "bg-slate-700 text-white";
  return "bg-blue-700 text-white";
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
  const [experiments, setExperiments] = useState<Record<string, ExperimentState>>({});
  const [securityTests, setSecurityTests] = useState<Record<string, SecurityTestState>>({});
  const [mutationInputs, setMutationInputs] = useState<Record<string, string>>({});
  const [scope, setScope] = useState<LiveScope>({ allowedHosts: [], allowedPorts: [], observedHosts: [] });
  const [trafficFilter, setTrafficFilter] = useState<TrafficFilter>("api");
  const [autoSecurityTesting, setAutoSecurityTesting] = useState(true);
  const [siteWalk, setSiteWalk] = useState<SiteWalkState>({ status: "idle", visited: 0, limit: 25 });

  const wsRef = useRef<WebSocket | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const analysis = useMemo(() => analyzeTraffic(exchanges, scope.allowedHosts), [exchanges, scope.allowedHosts]);
  const securityTestTargets = useMemo(
    () => exchanges.filter((exchange) => isSecurityTestTarget(exchange, scope.allowedHosts)),
    [exchanges, scope.allowedHosts]
  );
  const visibleExchanges = useMemo(
    () => (trafficFilter === "api" ? exchanges.filter((exchange) => isApiLikeUrl(exchange.request.url) || isJsonResponse(exchange)) : exchanges),
    [exchanges, trafficFilter]
  );
  const runningSecurityTests = Object.values(securityTests).filter((test) => test.status === "running").length;
  const completedSecurityTests = Object.values(securityTests).filter((test) => test.status === "done").length;
  const failedSecurityChecks = Object.values(securityTests).flatMap((test) =>
    test.status === "done" ? test.result.checks.filter((check) => check.status === "failed") : []
  ).length;
  const pendingSecurityTests = securityTestTargets.filter((exchange) => !securityTests[exchange.id]).length;
  const securityTestingActive = runningSecurityTests > 0;

  function sendInput(payload: Record<string, unknown>) {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
  }

  function stopSession() {
    sendInput({ type: "stop" });
    wsRef.current?.close();
    wsRef.current = null;
    setConnected(false);
  }

  useEffect(() => {
    if (!authSessionId) return;
    let cancelled = false;

    async function connect() {
      setConnecting(true);
      setError(null);
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
          setConnected(true);
          setConnecting(false);
        };
        ws.onmessage = (evt) => {
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
            setExchanges((prev) => (prev.some((e) => e.id === msg.exchange.id) ? prev : [...prev, msg.exchange]));
            const observedHost = hostnameFromUrl(msg.exchange?.request?.url ?? "");
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
            setSecurityTests((prev) => ({
              ...prev,
              [msg.exchangeId]: { status: "done", result: msg.result },
            }));
          } else if (msg.type === "securityTestError") {
            setSecurityTests((prev) => ({
              ...prev,
              [msg.exchangeId]: { status: "error", error: msg.error ?? "Security test failed" },
            }));
          } else if (msg.type === "siteWalk") {
            setSiteWalk({
              status: ["running", "visiting", "done", "failed"].includes(msg.status) ? msg.status : "idle",
              visited: Number.isFinite(msg.visited) ? msg.visited : 0,
              limit: Number.isFinite(msg.limit) ? msg.limit : 25,
              url: typeof msg.url === "string" ? msg.url : undefined,
              error: typeof msg.error === "string" ? msg.error : undefined,
            });
          } else if (msg.type === "status" && msg.status === "failed") {
            setError(msg.error ?? "Live session failed");
          }
        };
        ws.onerror = () => {
          setError("Live session disconnected.");
          setConnected(false);
        };
        ws.onclose = () => {
          if (wsRef.current === ws) wsRef.current = null;
          setConnected(false);
          setConnecting(false);
        };
      } catch (err: any) {
        if (!cancelled) {
          setError(err?.message ?? "Failed to start live testing session");
          setConnecting(false);
        }
      }
    }

    connect();
    return () => {
      cancelled = true;
      wsRef.current?.close();
      wsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authSessionId]);

  function runExperiment(exchange: SecurityHttpExchange, candidate: ResourceIdCandidate) {
    if (!connected) return;
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
    if (!connected) return;
    setExperiments((prev) => ({ ...prev, [exchange.id]: { status: "running", kind: "replay" } }));
    sendInput({ type: "replay", exchangeId: exchange.id });
  }

  function queueSecurityTests(targets: SecurityHttpExchange[], rerun = false) {
    if (!connected) return;
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    const running = Object.values(securityTests).filter((test) => test.status === "running").length;
    const capacity = Math.max(0, SECURITY_TEST_CONCURRENCY - running);
    const selected = targets
      .filter((exchange) => isSecurityTestTarget(exchange, scope.allowedHosts))
      .filter((exchange) => {
        const current = securityTests[exchange.id];
        return rerun ? current?.status !== "running" : !current;
      })
      .slice(0, capacity);
    if (selected.length === 0) return;

    setSecurityTests((prev) => {
      const next = { ...prev };
      for (const exchange of selected) next[exchange.id] = { status: "running" };
      return next;
    });
    for (const exchange of selected) sendInput({ type: "securityTest", exchangeId: exchange.id });
  }

  function runSecurityTest(exchange: SecurityHttpExchange) {
    queueSecurityTests([exchange], true);
  }

  function runApiSecurityTests() {
    queueSecurityTests(securityTestTargets);
  }

  function allowHost(host: string) {
    if (!connected) return;
    sendInput({ type: "allowHost", host });
  }

  function runSiteWalk() {
    if (!connected || siteWalk.status === "running" || siteWalk.status === "visiting") return;
    setSiteWalk((prev) => ({ ...prev, status: "running", error: undefined }));
    sendInput({ type: "siteWalk" });
  }

  useEffect(() => {
    if (!autoSecurityTesting) return;
    queueSecurityTests(securityTestTargets);
    // queueSecurityTests intentionally reads the latest state from this render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoSecurityTesting, connected, securityTestTargets, securityTests, scope.allowedHosts]);

  if (!authSessionId) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-10">
        <p className="text-sm text-slate-600">
          No auth session specified.{" "}
          <Link to="/security-scan" className="text-emerald-600 underline">
            Go back to Security Scan
          </Link>{" "}
          and start a Live Test from a captured Bug Bounty session.
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
            {connecting ? "Connecting..." : connected ? "Connected — browse the app normally." : "Disconnected"}
          </p>
        </div>
        <Button type="button" variant="outline" onClick={stopSession} disabled={!connected}>
          Stop session
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
              variant="outline"
              disabled={!connected || siteWalk.status === "running" || siteWalk.status === "visiting"}
              onClick={runSiteWalk}
            >
              {siteWalk.status === "running" || siteWalk.status === "visiting" ? "Walking site..." : "Run site walk"}
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => setAutoSecurityTesting((value) => !value)}>
              {autoSecurityTesting ? "Auto testing on" : "Auto testing paused"}
            </Button>
            <Button type="button" size="sm" disabled={!connected || pendingSecurityTests === 0} onClick={runApiSecurityTests}>
              <span className="inline-flex items-center gap-1.5">
                {securityTestingActive && <InlineSpinner />}
                {securityTestingActive ? `Running ${runningSecurityTests}` : `Run pending (${pendingSecurityTests})`}
              </span>
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="grid grid-cols-2 gap-2 md:grid-cols-7">
            <div className="rounded border border-slate-200 px-3 py-2">
              <div className="text-xs text-slate-500">Traffic</div>
              <div className="font-semibold text-slate-900">{analysis.total}</div>
            </div>
            <div className="rounded border border-slate-200 px-3 py-2">
              <div className="text-xs text-slate-500">API calls</div>
              <div className="font-semibold text-slate-900">{analysis.apiCount}</div>
            </div>
            <div className="rounded border border-slate-200 px-3 py-2">
              <div className="text-xs text-slate-500">Test ready</div>
              <div className="font-semibold text-slate-900">{analysis.securityTestableCount}</div>
            </div>
            <div className="rounded border border-slate-200 px-3 py-2">
              <div className="text-xs text-slate-500">ID targets</div>
              <div className="font-semibold text-slate-900">{analysis.testableCount}</div>
            </div>
            <div className="rounded border border-slate-200 px-3 py-2">
              <div className="text-xs text-slate-500">JSON IDs</div>
              <div className="font-semibold text-slate-900">{analysis.responseIdHints.length}</div>
            </div>
            <div className="rounded border border-slate-200 px-3 py-2">
              <div className="text-xs text-slate-500">Auth headers</div>
              <div className="font-semibold text-slate-900">{analysis.authenticated}</div>
            </div>
            <div className="rounded border border-slate-200 px-3 py-2">
              <div className="text-xs text-slate-500">Findings</div>
              <div className={failedSecurityChecks > 0 ? "font-semibold text-rose-600" : "font-semibold text-slate-900"}>
                {failedSecurityChecks}
              </div>
            </div>
          </div>

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
                  Continuous tester: {runningSecurityTests} running, {pendingSecurityTests} pending, {completedSecurityTests} completed.
                </span>
              </div>
              {securityTestingActive && (
                <div className="mt-1 text-xs text-blue-700">
                  Active API probes are still running. Results will appear under each captured request as they finish.
                </div>
              )}
            </div>
          )}

          {siteWalk.status !== "idle" && (
            <div className="rounded border border-slate-200 bg-slate-50 px-3 py-2 text-slate-700">
              Site walk: {siteWalk.status} ({siteWalk.visited}/{siteWalk.limit})
              {siteWalk.url ? ` ${pathnameFromUrl(siteWalk.url)}` : ""}
              {siteWalk.error ? ` ${siteWalk.error}` : ""}
            </div>
          )}

          {analysis.outOfScopeHosts.length > 0 && (
            <div className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-amber-900">
              <div className="mb-2 font-medium">API traffic is being captured on hosts that are not authorized for security tests.</div>
              <div className="flex flex-wrap gap-2">
                {analysis.outOfScopeHosts.map((host) => (
                  <Button key={host} type="button" size="sm" variant="outline" disabled={!connected} onClick={() => allowHost(host)}>
                    Authorize {host}
                  </Button>
                ))}
              </div>
            </div>
          )}

          {analysis.total > 0 && analysis.testableCount === 0 && (
            <div className="rounded border border-slate-200 bg-slate-50 px-3 py-2 text-slate-700">
              No URL-ID mutation target yet. API security tests can still run on captured API/JSON GET responses.
            </div>
          )}

          {analysis.stateChangingCount > 0 && (
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
              Captured traffic ({visibleExchanges.length}/{exchanges.length})
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
            {exchanges.length === 0 && <p className="text-sm text-slate-500">No requests captured yet — browse the app.</p>}
            {exchanges.length > 0 && visibleExchanges.length === 0 && (
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
              const replayDisabled = !connected || !isGet || !hasResponse || !hostAllowed || isRunning;
              const canSecurityTest = isSecurityTestTarget(exchange, scope.allowedHosts);
              const securityTest = securityTests[exchange.id];
              const isSecurityRunning = securityTest?.status === "running";
              const failedChecks =
                securityTest?.status === "done" ? securityTest.result.checks.filter((check) => check.status === "failed") : [];
              const probeCount = securityTest?.status === "done" ? securityTest.result.probes?.length ?? 0 : 0;
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
                      <Button type="button" size="sm" disabled={!canSecurityTest || isSecurityRunning} onClick={() => runSecurityTest(exchange)}>
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
                        <Button type="button" size="sm" variant="outline" disabled={!connected} onClick={() => allowHost(host)}>
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
                            disabled={!connected || !hostAllowed || !mutationInputs[key]?.trim() || isRunning}
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
                      </div>
                      <div className="space-y-1">
                        {securityTest.result.checks.map((check) => {
                          const evidence = compactEvidence(check.evidence);
                          return (
                            <div key={check.id} className={`rounded border px-2 py-1 ${securityCheckClass(check.status)}`}>
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="font-medium">{check.title}</span>
                                <span className={`rounded px-1.5 py-0.5 uppercase ${securityStatusBadgeClass(check.status)}`}>
                                  {check.status}
                                </span>
                                <span className="rounded border border-slate-300 bg-white px-1.5 py-0.5 text-slate-800 shadow-sm">
                                  {check.severity}
                                </span>
                                {check.owaspApiCategory && (
                                  <span className="rounded border border-slate-300 bg-white px-1.5 py-0.5 text-slate-800 shadow-sm">
                                    {check.owaspApiCategory}
                                  </span>
                                )}
                                <span className="rounded border border-slate-300 bg-white px-1.5 py-0.5 text-slate-800 shadow-sm">
                                  {compactSecurityLabel(check.vulnerabilityClass)}
                                </span>
                              </div>
                              <div className="mt-0.5 text-[11px]">{check.description}</div>
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
