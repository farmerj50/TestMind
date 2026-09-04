import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import type { FastifyInstance } from "fastify";
import type WebSocket from "ws";
// patchright, not playwright — see auth-session-stream.ts for why (Runtime.enable CDP
// leak fix; scoped to the two files that attach a live CDP session).
import { chromium, type Browser, type BrowserContext, type Page, type CDPSession } from "patchright";
import { prisma } from "../prisma.js";
import { dispatchMouseInput, dispatchKeyInput } from "./live-input-forwarding.js";
import {
  enqueuePersistExchange,
  enqueuePersistExperiment,
  loadPersistedExchange,
  getPersistQueueDepth,
  PERSIST_QUEUE_HIGH_WATERMARK,
  PERSIST_QUEUE_LOW_WATERMARK,
} from "./live-security-persist.js";
import { runIdMutationExperiment, runReplayExperiment } from "../security/experiment.js";
import { runLiveSecurityTests, type BrowserCorsReadResult } from "../security/live-security-tests.js";
import type { SecurityHttpExchange, ResourceIdCandidate } from "../security/http-exchange.js";
import {
  clientExchange,
  truncateText,
  MAX_CAPTURED_BODY_CHARS,
  MAX_CAPTURED_POST_DATA_CHARS,
} from "../security/live-exchange-serialize.js";
import { isWithinScope, type ProbeScope } from "../security/http-client.js";
import { snippet } from "../security/redaction.js";

// Live Security Testing v0.1 (POC) - a person drives a real, already-authenticated
// browser session resumed from a captured SecurityAuthSession. This session captures
// HTTP traffic through CDP, runs safe GET-only API checks, and supports manual replay
// or resource-ID mutation against server-captured baselines.
//
// Unlike auth-session-stream.ts, this session does NOT auto-close on any pattern match —
// it stays open until the client disconnects or the session is explicitly stopped, since
// its whole purpose is continued browsing after auth is already established.
//
// This is intentionally simpler than auth-session-stream.ts's browser launch: no bot-
// detection stealth fingerprinting (addInitScript, header injection) — that machinery
// exists to get PAST a login page's bot checks, but this session starts already
// authenticated via a resumed storageState, so there's no login-time challenge to evade.

const TICKET_TTL_MS = 60_000;
const IDLE_TIMEOUT_MS = 30 * 60_000; // longer than auth-capture — this is an active testing session, not a quick login
const VIEWPORT = { width: 1280, height: 800 };
// Ticket 0.4: shrunk from 5_000 — matches the frontend's own MAX_RETAINED_EXCHANGES = 500, no
// value buffering server-side far beyond what any client ever renders. Durable storage
// (Ticket 0.2/0.3) is the overflow now, not a bigger in-memory number.
const MAX_BUFFERED_EXCHANGES = 400;
const MAX_PENDING_NETWORK_ENTRIES = 2_000;
// Memory-pressure throttling (Ticket 0.4, §4) — crossing this heapUsed threshold degrades
// capture (metadata-only, halved effective buffer cap) until usage recovers with margin.
const LIVE_SECURITY_HEAP_THROTTLE_BYTES = Number(process.env.TM_LIVE_SECURITY_HEAP_THROTTLE_BYTES) || 1_610_612_736; // ~1.5GB
const HEAP_CHECK_INTERVAL_MS = 5_000;
const MAX_BODY_RETRIEVAL_BYTES = 512_000;
const ACTION_CORRELATION_WINDOW_MS = 2_000;
const MAX_AUTOMATED_SCAN_STEPS = 100;
const MAX_INTERACTIONS_PER_PAGE = 12;
const MAX_SEARCH_INPUTS_PER_PAGE = 4;
const AUTOMATED_SCAN_SETTLE_MS = 700;
const DEFAULT_AUTOMATED_SCAN_DELAY_MS = 5_000;
const MAX_AUTOMATED_SCAN_DELAY_MS = 60_000;
const MAX_BROWSER_CORS_PROOFS_PER_SESSION = 25;
const BROWSER_CORS_PROOF_TIMEOUT_MS = 2_500;
const RATE_LIMIT_SIGNAL_WINDOW_MS = 60_000;
const RATE_LIMIT_SIGNAL_THRESHOLD = 3;
const DANGEROUS_ROUTE_RE =
  /(logout|log-out|signout|sign-out|delete|remove|destroy|deactivate|close-account|cancel|billing|checkout|payment|purchase|subscribe|transfer|withdraw|deposit|fund|trade|buy|sell|invest|order|confirm|submit|upload|enroll|enrol|sign-up|signup|register|apply|application|finish|continue)/i;
const SAFE_SEARCH_INPUT_RE = /(search|filter|query|find|lookup)/i;
const VOLATILE_CORS_QUERY_PARAM_RE =
  /^(client[_-]?request[_-]?id|request[_-]?id|trace[_-]?id|correlation[_-]?id|cache[_-]?bust|cachebuster|nonce|timestamp|ts|t|_|cb|rand|random)$/i;
const TEXT_LIKE_CONTENT_TYPE_RE =
  /\b(application\/(?:json|[\w.+-]+\+json|xml|x-www-form-urlencoded|graphql)|text\/|multipart\/form-data)\b/i;
const RATE_LIMIT_STATUS_CODES = new Set([429, 503, 509, 529]);
const WAF_RATE_LIMIT_TEXT_RE = /(error\s*1015|you are being rate limited|banned temporarily|too many requests)/i;

type Ticket = { authSessionId: string; expiresAt: number };
const tickets = new Map<string, Ticket>();

export function issueLiveTestTicket(authSessionId: string): string {
  const ticket = crypto.randomBytes(24).toString("hex");
  tickets.set(ticket, { authSessionId, expiresAt: Date.now() + TICKET_TTL_MS });
  return ticket;
}

function consumeLiveTestTicket(authSessionId: string, ticket: string): boolean {
  const entry = tickets.get(ticket);
  if (!entry) return false;
  tickets.delete(ticket);
  return entry.expiresAt >= Date.now() && entry.authSessionId === authSessionId;
}

type PendingRequest = {
  method: string;
  url: string;
  headers: Record<string, string>;
  postData?: string;
  timestamp: number;
};

type PendingResponse = {
  status: number;
  headers: Record<string, string>;
};

type AutomatedClickTarget = {
  selector: string;
  fingerprint: string;
  label: string;
};

type AutomatedSearchTarget = {
  selector: string;
  fingerprint: string;
  label: string;
};

type LiveSession = {
  id: string; // = SecurityAuthSession id
  baseUrl: string;
  browser: Browser;
  context: BrowserContext;
  page: Page;
  cdp: CDPSession;
  sockets: Set<WebSocket>;
  scope: ProbeScope;
  observedHosts: Set<string>;
  exchanges: SecurityHttpExchange[]; // ring buffer, oldest evicted first
  exchangesById: Map<string, SecurityHttpExchange>;
  // Ticket 0.4: ids whose in-memory body/postData have been shrunk to a redacted snippet
  // after durable persistence succeeded — resolveExchange() treats a hit here as needing a
  // full reload from durable storage rather than using the snippet directly.
  persistedSnippetIds: Set<string>;
  effectiveMaxBufferedExchanges: number; // MAX_BUFFERED_EXCHANGES, temporarily halved under memory pressure
  captureDegraded: boolean; // degradedByBacklog || degradedByMemory — metadata-only capture while true
  degradedByBacklog: boolean;
  degradedByMemory: boolean;
  heapCheckHandle?: NodeJS.Timeout;
  pendingRequests: Map<string, PendingRequest>; // keyed by CDP requestId
  pendingRequestExtraHeaders: Map<string, Record<string, string>>; // keyed by CDP requestId
  pendingResponses: Map<string, PendingResponse>;
  browserCorsProofCache: Map<string, BrowserCorsReadResult>;
  browserCorsProofInFlight: Map<string, Promise<BrowserCorsReadResult>>;
  browserCorsProofCount: number;
  routeWalkSeen: Set<string>;
  routeWalkRunning: boolean;
  routeWalkPausedByRateLimit: boolean;
  rateLimitSignals: number[];
  automatedScanDelayMs: number;
  lastInputAt: number;
  idleHandle: NodeJS.Timeout;
  closed: boolean;
};

const active = new Map<string, LiveSession>();

function broadcast(session: LiveSession, payload: unknown) {
  const msg = JSON.stringify(payload);
  for (const ws of session.sockets) {
    if (ws.readyState === ws.OPEN) ws.send(msg);
  }
}

function normalizeHeaders(headers: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (typeof value === "string") out[key] = value;
    else if (Array.isArray(value)) out[key] = value.map(String).join("; ");
    else if (value !== undefined && value !== null) out[key] = String(value);
  }
  return out;
}

function headerValue(headers: Record<string, string> | undefined, name: string) {
  if (!headers) return "";
  return Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1] ?? "";
}

function mergeHeaders(base: Record<string, string>, extra: Record<string, string>): Record<string, string> {
  const out = { ...base };
  const index = new Map(Object.keys(out).map((key) => [key.toLowerCase(), key]));
  for (const [key, value] of Object.entries(extra)) {
    const existing = index.get(key.toLowerCase());
    if (existing) out[existing] = value;
    else out[key] = value;
  }
  return out;
}

function contentLengthBytes(headers: Record<string, string> | undefined): number | undefined {
  const raw = headerValue(headers, "content-length").trim();
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function shouldCaptureResponseBody(request: PendingRequest, response: PendingResponse | undefined, encodedDataLength: number | undefined) {
  if (!response) return false;
  const method = request.method.toUpperCase();
  if (method === "HEAD" || method === "OPTIONS") return false;
  let pathname: string;
  try {
    pathname = new URL(request.url).pathname;
  } catch {
    return false;
  }
  if (isStaticPath(pathname)) return false;

  const contentLength = contentLengthBytes(response.headers);
  if (contentLength !== undefined && contentLength > MAX_BODY_RETRIEVAL_BYTES) return false;
  if (encodedDataLength !== undefined && encodedDataLength > MAX_BODY_RETRIEVAL_BYTES) return false;

  const contentType = headerValue(response.headers, "content-type");
  if (contentType) return TEXT_LIKE_CONTENT_TYPE_RE.test(contentType);
  return isApiLikePath(pathname);
}

function trimMapToMax<K, V>(map: Map<K, V>, maxEntries: number) {
  while (map.size > maxEntries) {
    const first = map.keys().next();
    if (first.done) return;
    map.delete(first.value);
  }
}

function prunePendingNetworkState(session: LiveSession) {
  trimMapToMax(session.pendingRequests, MAX_PENDING_NETWORK_ENTRIES);
  trimMapToMax(session.pendingRequestExtraHeaders, MAX_PENDING_NETWORK_ENTRIES);
  trimMapToMax(session.pendingResponses, MAX_PENDING_NETWORK_ENTRIES);
}

function boundedAutomationDelayMs(value: unknown, fallback: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(MAX_AUTOMATED_SCAN_DELAY_MS, Math.max(0, Math.trunc(parsed)));
}

function setAutomatedScanPacing(session: LiveSession, msg: any) {
  session.automatedScanDelayMs = boundedAutomationDelayMs(msg.dispatchDelayMs ?? msg.delayMs, session.automatedScanDelayMs);
  broadcast(session, {
    type: "automationPacing",
    dispatchDelayMs: session.automatedScanDelayMs,
  });
}

function hostnameFromUrl(rawUrl: string): string | null {
  try {
    return new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function scopeSnapshot(session: LiveSession) {
  return {
    allowedHosts: session.scope.allowedHosts,
    allowedPorts: session.scope.allowedPorts,
    observedHosts: [...session.observedHosts].sort(),
  };
}

function observeHost(session: LiveSession, rawUrl: string) {
  const hostname = hostnameFromUrl(rawUrl);
  if (!hostname || session.observedHosts.has(hostname)) return;
  session.observedHosts.add(hostname);
  broadcast(session, { type: "scope", ...scopeSnapshot(session) });
}

function looksJsonBody(body: string | undefined) {
  const trimmed = body?.trim() ?? "";
  return (trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"));
}

function isApiLikePath(pathname: string) {
  return /\/(api|graphql|rest|rpc|v\d+)\b/i.test(pathname);
}

function isBufferedSecurityCandidate(exchange: SecurityHttpExchange) {
  if (!exchange.response) return false;
  let pathname: string;
  try {
    pathname = new URL(exchange.request.url).pathname;
  } catch {
    return false;
  }
  if (isStaticPath(pathname)) return false;
  return (
    isApiLikePath(pathname) ||
    /\bapplication\/(?:json|[\w.+-]+\+json)\b/i.test(headerValue(exchange.response.headers, "content-type")) ||
    looksJsonBody(exchange.response.body)
  );
}

function isRateLimitExchange(exchange: SecurityHttpExchange) {
  const status = exchange.response?.status;
  if (typeof status === "number" && RATE_LIMIT_STATUS_CODES.has(status)) return true;
  return WAF_RATE_LIMIT_TEXT_RE.test(exchange.response?.body ?? "");
}

function registerRateLimitSignal(session: LiveSession, source: string) {
  const now = Date.now();
  session.rateLimitSignals = [...session.rateLimitSignals.filter((timestamp) => now - timestamp <= RATE_LIMIT_SIGNAL_WINDOW_MS), now];
  session.automatedScanDelayMs = Math.min(
    MAX_AUTOMATED_SCAN_DELAY_MS,
    Math.max(1_000, session.automatedScanDelayMs > 0 ? session.automatedScanDelayMs * 2 : 1_000)
  );
  if (!session.routeWalkPausedByRateLimit && session.rateLimitSignals.length >= RATE_LIMIT_SIGNAL_THRESHOLD) {
    session.routeWalkPausedByRateLimit = true;
    broadcast(session, {
      type: "rateLimit",
      source,
      count: session.rateLimitSignals.length,
      dispatchDelayMs: session.automatedScanDelayMs,
      pauseActiveTests: true,
      error: "Rate limit or WAF block detected. Automated walking and active probes were paused to preserve the session.",
    });
  }
}

function evictBufferedExchange(session: LiveSession) {
  const evictIndex = session.exchanges.findIndex((exchange) => !isBufferedSecurityCandidate(exchange));
  const [removed] = session.exchanges.splice(evictIndex >= 0 ? evictIndex : 0, 1);
  if (removed) {
    session.exchangesById.delete(removed.id);
    session.persistedSnippetIds.delete(removed.id);
  }
}

// Ticket 0.4 (§4) — two independent degrade reasons (persist backlog, memory pressure)
// combine into the single session.captureDegraded flag that shouldCaptureResponseBody
// consults. Kept deliberately separate from the existing routeWalkPausedByRateLimit /
// automatedScanDelayMs machinery (outbound rate-limit/WAF backoff) — neither can suppress
// the other by construction. Broadcasts only fire on the combined flag's edge transitions,
// never on every check, so a session sitting at the watermark doesn't spam the client.
export function setCaptureDegraded(session: LiveSession, reason: "persist backlog" | "memory pressure", active: boolean) {
  if (reason === "persist backlog") session.degradedByBacklog = active;
  else session.degradedByMemory = active;

  if (reason === "memory pressure") {
    session.effectiveMaxBufferedExchanges = active
      ? Math.max(1, Math.floor(MAX_BUFFERED_EXCHANGES / 2))
      : MAX_BUFFERED_EXCHANGES;
    while (session.exchanges.length > session.effectiveMaxBufferedExchanges) evictBufferedExchange(session);
  }

  const next = session.degradedByBacklog || session.degradedByMemory;
  if (next !== session.captureDegraded) {
    session.captureDegraded = next;
    broadcast(session, { type: "captureThrottled", reason, active: next });
  }
}

export function checkBacklogWatermark(session: LiveSession) {
  const depth = getPersistQueueDepth();
  if (!session.degradedByBacklog && depth >= PERSIST_QUEUE_HIGH_WATERMARK) {
    setCaptureDegraded(session, "persist backlog", true);
  } else if (session.degradedByBacklog && depth <= PERSIST_QUEUE_LOW_WATERMARK) {
    setCaptureDegraded(session, "persist backlog", false);
  }
}

function checkMemoryPressure(session: LiveSession) {
  if (session.closed) return;
  const heapUsed = process.memoryUsage().heapUsed;
  if (!session.degradedByMemory && heapUsed >= LIVE_SECURITY_HEAP_THROTTLE_BYTES) {
    setCaptureDegraded(session, "memory pressure", true);
  } else if (session.degradedByMemory && heapUsed < LIVE_SECURITY_HEAP_THROTTLE_BYTES * 0.9) {
    // 10% recovery margin so it doesn't flap right at the threshold.
    setCaptureDegraded(session, "memory pressure", false);
  }
}

export function pushExchange(session: LiveSession, exchange: SecurityHttpExchange) {
  session.exchanges.push(exchange);
  session.exchangesById.set(exchange.id, exchange);
  while (session.exchanges.length > session.effectiveMaxBufferedExchanges) evictBufferedExchange(session);
  enqueuePersistExchange(
    exchange,
    (err: any) => console.warn(`[live-security-session] failed to persist exchange ${exchange.id}:`, err?.message ?? err),
    () => {
      // Bound per-entry memory, not just count: once durably persisted, the in-memory copy
      // only needs to identify the exchange and support UI display, not carry the full body.
      if (exchange.request.postData) exchange.request.postData = snippet(exchange.request.postData);
      if (exchange.response?.body) exchange.response.body = snippet(exchange.response.body);
      session.persistedSnippetIds.add(exchange.id);
    }
  );
}

function browserCorsReadResult(
  url: string,
  origin: string,
  input: {
    status?: number;
    body?: string;
    headers?: Record<string, string>;
    error?: string;
    browserReadable: boolean;
    browserBlocked: boolean;
    browserSkipped?: boolean;
  }
): BrowserCorsReadResult {
  const body = truncateText(input.body, MAX_CAPTURED_BODY_CHARS) ?? "";
  return {
    method: "GET",
    url,
    status: input.status,
    body,
    bodyLength: body.length,
    bodySnippet: snippet(body),
    headers: input.headers ?? {},
    error: input.error,
    browserReadable: input.browserReadable,
    browserBlocked: input.browserBlocked,
    browserSkipped: input.browserSkipped,
    browserOrigin: origin,
  };
}

function browserCorsProofCacheKey(rawUrl: string) {
  try {
    const url = new URL(rawUrl);
    for (const key of [...url.searchParams.keys()]) {
      if (VOLATILE_CORS_QUERY_PARAM_RE.test(key)) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    return `${url.origin}${url.pathname}${url.search}`;
  } catch {
    return rawUrl;
  }
}

async function closeServer(server: http.Server) {
  await new Promise<void>((resolve) => server.close(() => resolve())).catch(() => {});
}

async function runCachedBrowserCorsReadProbe(session: LiveSession, url: string, timeoutMs: number): Promise<BrowserCorsReadResult> {
  const cacheKey = browserCorsProofCacheKey(url);
  const cached = session.browserCorsProofCache.get(cacheKey);
  if (cached) return { ...cached, url };

  const inFlight = session.browserCorsProofInFlight.get(cacheKey);
  if (inFlight) return { ...(await inFlight), url };

  if (session.browserCorsProofCount >= MAX_BROWSER_CORS_PROOFS_PER_SESSION) {
    return browserCorsReadResult(url, "local-test-origin", {
      browserReadable: false,
      browserBlocked: false,
      browserSkipped: true,
      error: `Browser CORS proof cap reached (${MAX_BROWSER_CORS_PROOFS_PER_SESSION} per live session).`,
    });
  }

  session.browserCorsProofCount += 1;
  const promise = runBrowserCorsReadProbe(session, url, Math.min(timeoutMs, BROWSER_CORS_PROOF_TIMEOUT_MS));
  session.browserCorsProofInFlight.set(cacheKey, promise);
  try {
    const result = await promise;
    session.browserCorsProofCache.set(cacheKey, result);
    return result;
  } finally {
    session.browserCorsProofInFlight.delete(cacheKey);
  }
}

async function runBrowserCorsReadProbe(session: LiveSession, url: string, timeoutMs: number): Promise<BrowserCorsReadResult> {
  if (!isWithinScope(url, session.scope.allowedHosts, session.scope.allowedPorts)) {
    return browserCorsReadResult(url, "local-test-origin", {
      browserReadable: false,
      browserBlocked: true,
      error: "URL is outside allowed security scan scope.",
    });
  }

  const server = http.createServer((_req, res) => {
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end("<!doctype html><title>TestMind CORS proof</title>");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  const origin = typeof address === "object" && address ? `http://127.0.0.1:${address.port}` : "local-test-origin";
  let proofPage: Page | null = null;
  try {
    proofPage = await session.context.newPage();
    await proofPage.goto(`${origin}/`, { waitUntil: "domcontentloaded", timeout: Math.min(timeoutMs, 5_000) });
    const result = await proofPage.evaluate(
      async ({
        targetUrl,
        timeoutMs: browserTimeoutMs,
        maxBodyChars,
      }: {
        targetUrl: string;
        timeoutMs: number;
        maxBodyChars: number;
      }) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), browserTimeoutMs);
        try {
          const response = await fetch(targetUrl, {
            method: "GET",
            credentials: "include",
            mode: "cors",
            signal: controller.signal,
          });
          const headers: Record<string, string> = {};
          response.headers.forEach((value, key) => {
            headers[key.toLowerCase()] = value;
          });
          let body = "";
          if (response.body) {
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            try {
              while (body.length < maxBodyChars) {
                const { done, value } = await reader.read();
                if (done) {
                  body += decoder.decode();
                  break;
                }
                body += decoder.decode(value, { stream: true });
              }
              if (body.length >= maxBodyChars) {
                await reader.cancel().catch(() => {});
                body = `${body.slice(0, maxBodyChars)}\n...[truncated in browser CORS proof]`;
              }
            } finally {
              reader.releaseLock();
            }
          } else {
            body = (await response.text()).slice(0, maxBodyChars);
          }
          return { browserReadable: true, browserBlocked: false, status: response.status, headers, body };
        } catch (err: any) {
          return {
            browserReadable: false,
            browserBlocked: true,
            error: err?.message ?? String(err),
          };
        } finally {
          clearTimeout(timer);
        }
      },
      { targetUrl: url, timeoutMs, maxBodyChars: MAX_CAPTURED_BODY_CHARS }
    );
    return browserCorsReadResult(url, origin, result);
  } catch (err: any) {
    return browserCorsReadResult(url, origin, {
      browserReadable: false,
      browserBlocked: true,
      error: err?.message ?? String(err),
    });
  } finally {
    if (proofPage) await proofPage.close().catch(() => {});
    await closeServer(server);
  }
}

function normalizeRouteUrl(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isDangerousSignal(signal: string) {
  return DANGEROUS_ROUTE_RE.test(signal.toLowerCase());
}

function automatedScanLimitPayload(
  session: LiveSession,
  reason: "initial" | "manual",
  status: "running" | "visiting" | "done" | "failed" | "stopped" | "paused",
  extra: Record<string, unknown> = {}
) {
  return {
    type: "siteWalk",
    status,
    reason,
    limit: MAX_AUTOMATED_SCAN_STEPS,
    ...extra,
  };
}

async function detectBrowserRateLimitPage(session: LiveSession) {
  const text = await session.page
    .evaluate(() => {
      const doc = (globalThis as any).document;
      return `${doc?.title ?? ""}\n${doc?.body?.innerText ?? ""}`.slice(0, 4000);
    })
    .catch(() => "");
  return WAF_RATE_LIMIT_TEXT_RE.test(text);
}

async function pauseAutomatedScanIfRateLimited(session: LiveSession, progress: AutomatedScanProgress, source: string) {
  if (session.routeWalkPausedByRateLimit) return true;
  const blocked = await detectBrowserRateLimitPage(session);
  if (!blocked) return false;
  session.routeWalkPausedByRateLimit = true;
  broadcast(
    session,
    automatedScanLimitPayload(session, progress.reason, "paused", {
      visited: progress.visited,
      url: session.page.url(),
      action: source,
      dispatchDelayMs: session.automatedScanDelayMs,
      pauseActiveTests: true,
      rateLimited: true,
      error: "Rate limit or WAF block detected. Automated scan paused.",
    })
  );
  return true;
}

function isSafeRouteWalkTarget(baseUrl: string, candidate: { url: string; text: string }) {
  try {
    const base = new URL(baseUrl);
    const url = new URL(candidate.url);
    if (url.origin !== base.origin) return false;
    if (isStaticPath(url.pathname)) return false;
    const signal = `${url.pathname} ${url.search} ${candidate.text}`.toLowerCase();
    return !isDangerousSignal(signal);
  } catch {
    return false;
  }
}

function isStaticPath(pathname: string) {
  return /\.(?:css|js|mjs|map|png|jpe?g|gif|webp|svg|ico|woff2?|ttf|pdf|zip)$/i.test(pathname);
}

async function collectSafeRouteWalkTargets(session: LiveSession) {
  const rawTargets = await session.page
    .evaluate(() => {
      const doc = (globalThis as any).document;
      return Array.from(doc.querySelectorAll("a[href]")).map((anchor: any) => {
        const link = anchor;
        return {
          url: link.href,
          text: (link.innerText || link.getAttribute("aria-label") || link.getAttribute("title") || "").slice(0, 120),
        };
      });
    })
    .catch(() => []);

  const targets: string[] = [];
  for (const candidate of rawTargets) {
    const normalized = normalizeRouteUrl(candidate.url);
    if (!normalized) continue;
    const seenKey = `route:${normalized}`;
    if (session.routeWalkSeen.has(seenKey)) continue;
    if (!isSafeRouteWalkTarget(session.baseUrl, { ...candidate, url: normalized })) continue;
    session.routeWalkSeen.add(seenKey);
    targets.push(normalized);
  }
  return targets;
}

async function collectSafeClickTargets(session: LiveSession): Promise<AutomatedClickTarget[]> {
  const rawTargets = await session.page
    .evaluate(
      ({ dangerousSource }: { dangerousSource: string }) => {
        const doc = (globalThis as any).document;
        const win = (globalThis as any).window;
        const dangerous = new RegExp(dangerousSource, "i");
        const visible = (el: any) => {
          const rect = el.getBoundingClientRect?.();
          const style = win.getComputedStyle?.(el);
          return Boolean(rect && rect.width > 4 && rect.height > 4 && style?.visibility !== "hidden" && style?.display !== "none");
        };
        const labelFor = (el: any) =>
          String(
            el.innerText ||
              el.getAttribute?.("aria-label") ||
              el.getAttribute?.("title") ||
              el.getAttribute?.("data-testid") ||
              el.id ||
              el.className ||
              ""
          )
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 120);

        const nodes = Array.from(
          doc.querySelectorAll(
            [
              "button",
              "[role='button']",
              "[role='tab']",
              "[role='menuitem']",
              "[aria-controls]",
              "summary",
              "[data-testid]",
              "[data-test]",
            ].join(",")
          )
        );
        const targets: AutomatedClickTarget[] = [];
        const seen = new Set<string>();
        nodes.forEach((node: any, index) => {
          if (targets.length >= 40 || !visible(node)) return;
          if (node.closest?.("[data-tm-ignore], [disabled], [aria-disabled='true']")) return;
          const tag = String(node.tagName || "").toLowerCase();
          const type = String(node.getAttribute?.("type") || "").toLowerCase();
          if (tag === "button" && ["submit", "reset"].includes(type)) return;
          if (node.closest?.("form") && !["button", "menu", "tab"].includes(String(node.getAttribute?.("role") || "").toLowerCase())) return;
          const label = labelFor(node);
          const href = String(node.getAttribute?.("href") || "");
          const signal = `${tag} ${type} ${href} ${label} ${node.getAttribute?.("aria-label") || ""} ${node.id || ""}`;
          if (!label && !node.getAttribute?.("aria-controls") && !node.getAttribute?.("data-testid")) return;
          if (dangerous.test(signal)) return;
          const fingerprint = `${win.location.pathname}|${tag}|${type}|${label}|${node.getAttribute?.("role") || ""}|${
            node.getAttribute?.("data-testid") || node.id || index
          }`;
          if (seen.has(fingerprint)) return;
          seen.add(fingerprint);
          const id = `tm-auto-click-${Date.now()}-${index}`;
          node.setAttribute("data-testmind-auto-id", id);
          targets.push({ selector: `[data-testmind-auto-id="${id}"]`, fingerprint, label: label || tag || "control" });
        });
        return targets;
      },
      { dangerousSource: DANGEROUS_ROUTE_RE.source }
    )
    .catch(() => []);

  return rawTargets.filter((target) => !isDangerousSignal(target.fingerprint) && !isDangerousSignal(target.label));
}

async function collectSafeSearchTargets(session: LiveSession): Promise<AutomatedSearchTarget[]> {
  const rawTargets = await session.page
    .evaluate(
      ({ searchSource }: { searchSource: string }) => {
        const doc = (globalThis as any).document;
        const win = (globalThis as any).window;
        const search = new RegExp(searchSource, "i");
        const visible = (el: any) => {
          const rect = el.getBoundingClientRect?.();
          const style = win.getComputedStyle?.(el);
          return Boolean(rect && rect.width > 20 && rect.height > 8 && style?.visibility !== "hidden" && style?.display !== "none");
        };
        const nodes = Array.from(doc.querySelectorAll("input, textarea, [role='searchbox']"));
        const targets: AutomatedSearchTarget[] = [];
        nodes.forEach((node: any, index) => {
          if (targets.length >= 12 || !visible(node)) return;
          if (node.disabled || node.readOnly || node.closest?.("[disabled], [aria-disabled='true']")) return;
          const type = String(node.getAttribute?.("type") || "text").toLowerCase();
          if (!["search", "text", ""].includes(type) && node.getAttribute?.("role") !== "searchbox") return;
          const label = String(
            node.getAttribute?.("placeholder") ||
              node.getAttribute?.("aria-label") ||
              node.getAttribute?.("name") ||
              node.id ||
              node.closest?.("label")?.innerText ||
              ""
          )
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 120);
          if (!search.test(label)) return;
          const fingerprint = `${win.location.pathname}|search|${label}|${node.getAttribute?.("name") || node.id || index}`;
          const id = `tm-auto-search-${Date.now()}-${index}`;
          node.setAttribute("data-testmind-auto-id", id);
          targets.push({ selector: `[data-testmind-auto-id="${id}"]`, fingerprint, label: label || "search" });
        });
        return targets;
      },
      { searchSource: SAFE_SEARCH_INPUT_RE.source }
    )
    .catch(() => []);

  return rawTargets;
}

async function settleAutomatedScanPage(session: LiveSession) {
  await session.page.waitForLoadState("domcontentloaded", { timeout: 4_000 }).catch(() => null);
  await session.page.waitForLoadState("networkidle", { timeout: 1_500 }).catch(() => null);
  await sleep(Math.max(AUTOMATED_SCAN_SETTLE_MS, session.automatedScanDelayMs));
}

type AutomatedScanProgress = {
  reason: "initial" | "manual";
  visited: number;
  routeQueue: string[];
};

function enqueueDiscoveredRoutes(progress: AutomatedScanProgress, routes: string[]) {
  for (const route of routes) {
    if (progress.visited + progress.routeQueue.length >= MAX_AUTOMATED_SCAN_STEPS) break;
    if (!progress.routeQueue.includes(route)) progress.routeQueue.push(route);
  }
}

function hasAutomatedScanBudget(progress: AutomatedScanProgress) {
  return progress.visited < MAX_AUTOMATED_SCAN_STEPS;
}

async function exerciseSafeSearchInputs(session: LiveSession, progress: AutomatedScanProgress) {
  const targets = (await collectSafeSearchTargets(session)).slice(0, MAX_SEARCH_INPUTS_PER_PAGE);
  for (const target of targets) {
    if (session.closed || session.routeWalkPausedByRateLimit || !hasAutomatedScanBudget(progress)) return;
    const seenKey = `search:${target.fingerprint}`;
    if (session.routeWalkSeen.has(seenKey)) continue;
    session.routeWalkSeen.add(seenKey);
    progress.visited += 1;
    broadcast(
      session,
      automatedScanLimitPayload(session, progress.reason, "visiting", {
        visited: progress.visited,
        url: session.page.url(),
        action: `search ${target.label}`,
      })
    );

    const locator = session.page.locator(target.selector).first();
    await locator.fill("testmind").catch(() => null);
    await locator.press("Enter").catch(() => null);
    await settleAutomatedScanPage(session);
    if (await pauseAutomatedScanIfRateLimited(session, progress, `search ${target.label}`)) return;
    enqueueDiscoveredRoutes(progress, await collectSafeRouteWalkTargets(session));
  }
}

async function exerciseSafePageControls(session: LiveSession, progress: AutomatedScanProgress) {
  const baseOrigin = new URL(session.baseUrl).origin;
  for (let pass = 0; pass < 2 && hasAutomatedScanBudget(progress) && !session.closed && !session.routeWalkPausedByRateLimit; pass += 1) {
    const targets = await collectSafeClickTargets(session);
    let clickedOnThisPage = 0;
    for (const target of targets) {
      if (session.closed || session.routeWalkPausedByRateLimit || !hasAutomatedScanBudget(progress) || clickedOnThisPage >= MAX_INTERACTIONS_PER_PAGE) return;
      const seenKey = `click:${target.fingerprint}`;
      if (session.routeWalkSeen.has(seenKey)) continue;
      session.routeWalkSeen.add(seenKey);

      const beforeUrl = session.page.url();
      progress.visited += 1;
      clickedOnThisPage += 1;
      broadcast(
        session,
        automatedScanLimitPayload(session, progress.reason, "visiting", {
          visited: progress.visited,
          url: beforeUrl,
          action: `click ${target.label}`,
        })
      );

      await session.page.locator(target.selector).first().click({ timeout: 3_000 }).catch(() => null);
      await settleAutomatedScanPage(session);
      if (await pauseAutomatedScanIfRateLimited(session, progress, `click ${target.label}`)) return;
      const afterUrl = session.page.url();
      enqueueDiscoveredRoutes(progress, await collectSafeRouteWalkTargets(session));

      try {
        const after = new URL(afterUrl);
        if (after.origin !== baseOrigin || isDangerousSignal(`${after.pathname} ${after.search}`)) {
          await session.page.goto(beforeUrl, { waitUntil: "domcontentloaded", timeout: 8_000 }).catch(() => null);
          await settleAutomatedScanPage(session);
        }
      } catch {
        await session.page.goto(beforeUrl, { waitUntil: "domcontentloaded", timeout: 8_000 }).catch(() => null);
        await settleAutomatedScanPage(session);
      }
    }
  }
}

async function scanCurrentPage(session: LiveSession, progress: AutomatedScanProgress) {
  if (await pauseAutomatedScanIfRateLimited(session, progress, "inspect page")) return;
  enqueueDiscoveredRoutes(progress, await collectSafeRouteWalkTargets(session));
  await exerciseSafeSearchInputs(session, progress);
  if (session.routeWalkPausedByRateLimit) return;
  await exerciseSafePageControls(session, progress);
  if (session.routeWalkPausedByRateLimit) return;
  enqueueDiscoveredRoutes(progress, await collectSafeRouteWalkTargets(session));
}

async function runSafeRouteWalk(session: LiveSession, reason: "initial" | "manual" = "manual") {
  if (session.routeWalkRunning || session.closed) return;
  session.routeWalkRunning = true;
  session.routeWalkPausedByRateLimit = false;
  session.rateLimitSignals = [];
  if (reason === "manual") session.routeWalkSeen.clear();
  const originalUrl = session.page.url();
  const progress: AutomatedScanProgress = { reason, visited: 0, routeQueue: [] };
  broadcast(session, automatedScanLimitPayload(session, reason, "running", { visited: progress.visited }));

  try {
    await settleAutomatedScanPage(session);
    await scanCurrentPage(session, progress);
    while (progress.routeQueue.length > 0 && hasAutomatedScanBudget(progress) && !session.closed && !session.routeWalkPausedByRateLimit) {
      const nextUrl = progress.routeQueue.shift();
      if (!nextUrl) continue;
      progress.visited += 1;
      broadcast(
        session,
        automatedScanLimitPayload(session, reason, "visiting", {
          url: nextUrl,
          visited: progress.visited,
          action: "visit route",
        })
      );
      await session.page.goto(nextUrl, { waitUntil: "domcontentloaded", timeout: 12_000 }).catch(() => null);
      await settleAutomatedScanPage(session);
      if (await pauseAutomatedScanIfRateLimited(session, progress, "visit route")) break;
      await scanCurrentPage(session, progress);
    }
  } finally {
    if (!session.closed && !session.routeWalkPausedByRateLimit) {
      await session.page.goto(originalUrl, { waitUntil: "domcontentloaded", timeout: 12_000 }).catch(() => null);
    }
    session.routeWalkRunning = false;
    if (!session.routeWalkPausedByRateLimit) {
      broadcast(session, automatedScanLimitPayload(session, reason, "done", { visited: progress.visited }));
    }
  }
}

export async function closeLiveSession(id: string): Promise<void> {
  const session = active.get(id);
  if (!session || session.closed) return;
  session.closed = true;
  clearTimeout(session.idleHandle);
  if (session.heapCheckHandle) clearInterval(session.heapCheckHandle);
  active.delete(id);
  for (const ws of session.sockets) {
    try { ws.close(); } catch {}
  }
  try { await session.browser.close(); } catch {}
}

// Exported for direct integration testing (no Prisma/WebSocket dependency in this function
// itself — those live in registerLiveSecuritySessionRoutes) and for any future session
// management tooling (e.g. an admin "list active live sessions" view).
export async function startLiveSession(authSession: {
  id: string;
  baseUrl: string | null;
  storagePath: string | null;
}): Promise<LiveSession> {
  if (!authSession.baseUrl) throw new Error("Auth session has no baseUrl to navigate to");
  if (!authSession.storagePath) throw new Error("Auth session has no captured storage state");

  const raw = await fs.readFile(authSession.storagePath, "utf8");
  let storageState: any;
  try {
    storageState = JSON.parse(raw);
  } catch {
    throw new Error("Captured storage state is not valid JSON");
  }
  // A bearer-token-only capture (OAuth/IdP provider flow) has no cookies/localStorage to
  // seed a browser context with — live browsing needs a real cookie-authenticated session.
  if (!storageState.cookies && !storageState.origins) {
    throw new Error(
      "This captured session has no browser storage state to resume — bearer-token-only captures aren't supported for live testing yet."
    );
  }

  const hostname = new URL(authSession.baseUrl).hostname;

  const browser = await chromium.launch({ headless: false, args: ["--no-sandbox"] });
  const context = await browser.newContext({ viewport: VIEWPORT, storageState });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);

  const session: LiveSession = {
    id: authSession.id,
    baseUrl: authSession.baseUrl,
    browser,
    context,
    page,
    cdp,
    sockets: new Set(),
    scope: { allowedHosts: [hostname], allowedPorts: [] },
    observedHosts: new Set([hostname]),
    exchanges: [],
    exchangesById: new Map(),
    persistedSnippetIds: new Set(),
    effectiveMaxBufferedExchanges: MAX_BUFFERED_EXCHANGES,
    captureDegraded: false,
    degradedByBacklog: false,
    degradedByMemory: false,
    pendingRequests: new Map(),
    pendingRequestExtraHeaders: new Map(),
    pendingResponses: new Map(),
    browserCorsProofCache: new Map(),
    browserCorsProofInFlight: new Map(),
    browserCorsProofCount: 0,
    routeWalkSeen: new Set(),
    routeWalkRunning: false,
    routeWalkPausedByRateLimit: false,
    rateLimitSignals: [],
    automatedScanDelayMs: DEFAULT_AUTOMATED_SCAN_DELAY_MS,
    lastInputAt: 0,
    idleHandle: setTimeout(() => {
      closeLiveSession(authSession.id).catch(() => {});
    }, IDLE_TIMEOUT_MS),
    closed: false,
  };
  active.set(authSession.id, session);
  session.heapCheckHandle = setInterval(() => checkMemoryPressure(session), HEAP_CHECK_INTERVAL_MS);

  cdp.on("Page.screencastFrame", (frame: any) => {
    broadcast(session, { type: "frame", data: frame.data, mimeType: "jpeg" });
    cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => {});
  });

  await cdp.send("Network.enable", {
    maxTotalBufferSize: MAX_BODY_RETRIEVAL_BYTES * 20,
    maxResourceBufferSize: MAX_BODY_RETRIEVAL_BYTES,
    maxPostDataSize: MAX_CAPTURED_POST_DATA_CHARS,
  });

  cdp.on("Network.requestWillBeSent", (evt: any) => {
    observeHost(session, evt.request.url);
    const extraHeaders = session.pendingRequestExtraHeaders.get(evt.requestId) ?? {};
    session.pendingRequests.set(evt.requestId, {
      method: evt.request.method,
      url: evt.request.url,
      headers: mergeHeaders(normalizeHeaders(evt.request.headers), extraHeaders),
      postData: truncateText(evt.request.postData, MAX_CAPTURED_POST_DATA_CHARS),
      timestamp: Date.now(),
    });
    prunePendingNetworkState(session);
  });

  cdp.on("Network.requestWillBeSentExtraInfo", (evt: any) => {
    const extraHeaders = normalizeHeaders(evt.headers);
    const pendingRequest = session.pendingRequests.get(evt.requestId);
    if (pendingRequest) {
      pendingRequest.headers = mergeHeaders(pendingRequest.headers, extraHeaders);
    } else {
      const previous = session.pendingRequestExtraHeaders.get(evt.requestId) ?? {};
      session.pendingRequestExtraHeaders.set(evt.requestId, mergeHeaders(previous, extraHeaders));
    }
    prunePendingNetworkState(session);
  });

  cdp.on("Network.responseReceived", (evt: any) => {
    session.pendingResponses.set(evt.requestId, {
      status: evt.response.status,
      headers: normalizeHeaders(evt.response.headers),
    });
    prunePendingNetworkState(session);
  });

  // Request failed before a response arrived (blocked, aborted, network error) — nothing
  // useful to show in the traffic panel for v0.1; just clear the pending state.
  cdp.on("Network.loadingFailed", (evt: any) => {
    session.pendingRequests.delete(evt.requestId);
    session.pendingRequestExtraHeaders.delete(evt.requestId);
    session.pendingResponses.delete(evt.requestId);
  });

  cdp.on("Network.loadingFinished", async (evt: any) => {
    const pendingRequest = session.pendingRequests.get(evt.requestId);
    const pendingResponse = session.pendingResponses.get(evt.requestId);
    session.pendingRequests.delete(evt.requestId);
    session.pendingRequestExtraHeaders.delete(evt.requestId);
    session.pendingResponses.delete(evt.requestId);
    if (!pendingRequest) return;

    // Ticket 0.4 (§4): checked once per captured exchange so a session degrades/recovers
    // promptly as the shared persist queue backs up or drains, independent of the periodic
    // memory-pressure interval.
    checkBacklogWatermark(session);

    let body: string | undefined;
    if (!session.captureDegraded && shouldCaptureResponseBody(pendingRequest, pendingResponse, evt.encodedDataLength)) {
      try {
        const bodyResult: any = await cdp.send("Network.getResponseBody", { requestId: evt.requestId });
        if (!bodyResult.base64Encoded) body = truncateText(bodyResult.body, MAX_CAPTURED_BODY_CHARS);
      } catch {
      // Body may be unavailable (redirect, opaque response, already-evicted from CDP's
      // buffer) — still record the exchange without it.
      }
    }

    const exchange: SecurityHttpExchange = {
      id: crypto.randomUUID(),
      sessionId: session.id,
      timestamp: pendingRequest.timestamp,
      request: {
        method: pendingRequest.method,
        url: pendingRequest.url,
        headers: pendingRequest.headers,
        postData: session.captureDegraded ? undefined : truncateText(pendingRequest.postData, MAX_CAPTURED_POST_DATA_CHARS),
      },
      response: pendingResponse
        ? {
            status: pendingResponse.status,
            headers: pendingResponse.headers,
            body,
            durationMs: Date.now() - pendingRequest.timestamp,
          }
        : undefined,
      correlatedActionId:
        Date.now() - session.lastInputAt < ACTION_CORRELATION_WINDOW_MS ? `input-${session.lastInputAt}` : undefined,
    };
    if (isRateLimitExchange(exchange)) registerRateLimitSignal(session, `HTTP ${exchange.response?.status ?? "rate-limit page"}`);
    pushExchange(session, exchange);
    broadcast(session, { type: "exchange", exchange: clientExchange(exchange) });
  });

  await page.goto(authSession.baseUrl, { waitUntil: "domcontentloaded" }).catch((err: any) => {
    console.warn(`[live-security-session] initial navigation failed for ${session.id}:`, err?.message ?? err);
  });

  await cdp.send("Page.startScreencast", {
    format: "jpeg",
    quality: 60,
    maxWidth: VIEWPORT.width,
    maxHeight: VIEWPORT.height,
    everyNthFrame: 1,
  });

  setTimeout(() => {
    runSafeRouteWalk(session, "initial").catch((err: any) => {
      console.warn(`[live-security-session] route walk failed for ${session.id}:`, err?.message ?? err);
      session.routeWalkRunning = false;
      broadcast(session, { type: "siteWalk", status: "failed", error: err?.message ?? String(err) });
    });
  }, 500);

  return session;
}

// Ticket 0.3 — durable exchange retrieval. The in-memory buffer remains the primary path;
// this only adds a fallback for an exchange that's scrolled out of it. Scoped to this
// session's own authSessionId inside loadPersistedExchange, so an exchange id belonging to
// another session can never be resolved here — same invariant the in-memory Map already gave
// for free (session.exchangesById is per-session), now preserved for the durable path too.
async function resolveExchange(session: LiveSession, exchangeId: string): Promise<SecurityHttpExchange | undefined> {
  const hit = session.exchangesById.get(exchangeId);
  // A hit whose body/postData were shrunk to a snippet post-persist (Ticket 0.4, §3) can't be
  // used directly — reload the full data from durable storage. Fall back to the snippet-only
  // copy only if that reload unexpectedly fails, rather than turning a memory-bounding
  // optimization into a new way to lose an otherwise-known exchange.
  if (hit && !session.persistedSnippetIds.has(exchangeId)) return hit;
  const persisted = await loadPersistedExchange(session.id, exchangeId);
  return persisted ?? hit;
}

// Ticket 0.5 — durable experiment history. Called AFTER the existing WS broadcast in each of
// handleMutateMessage/handleReplayMessage/handleSecurityTestMessage, fire-and-forget, so a
// persistence failure can never affect the live result path that already reached the client.
function persistMutationOrReplayResult(
  session: LiveSession,
  exchange: SecurityHttpExchange,
  kind: "mutation" | "replay",
  requestJson: unknown,
  result: { mutatedResult: { status?: number; body: string }; diff: unknown }
): void {
  enqueuePersistExperiment(
    {
      authSessionId: session.id,
      baselineExchangeId: exchange.id,
      baselineUrl: exchange.request.url,
      baselineMethod: exchange.request.method,
      kind,
      requestJson,
      resultStatus: result.mutatedResult.status,
      resultBody: result.mutatedResult.body,
      diffJson: result.diff,
    },
    (err: any) => console.warn(`[live-security-session] failed to persist ${kind} experiment for ${exchange.id}:`, err?.message ?? err)
  );
}

function persistSecurityTestResult(session: LiveSession, exchange: SecurityHttpExchange, result: unknown): void {
  enqueuePersistExperiment(
    {
      authSessionId: session.id,
      baselineExchangeId: exchange.id,
      baselineUrl: exchange.request.url,
      baselineMethod: exchange.request.method,
      kind: "securityTest",
      securityTestResultJson: result,
    },
    (err: any) => console.warn(`[live-security-session] failed to persist securityTest experiment for ${exchange.id}:`, err?.message ?? err)
  );
}

function persistExperimentError(
  session: LiveSession,
  exchange: SecurityHttpExchange,
  kind: "mutation" | "replay" | "securityTest",
  requestJson: unknown,
  err: any
): void {
  enqueuePersistExperiment(
    {
      authSessionId: session.id,
      baselineExchangeId: exchange.id,
      baselineUrl: exchange.request.url,
      baselineMethod: exchange.request.method,
      kind,
      requestJson,
      error: err?.message ?? String(err),
    },
    (persistErr: any) =>
      console.warn(`[live-security-session] failed to persist ${kind} experiment error for ${exchange.id}:`, persistErr?.message ?? persistErr)
  );
}

async function handleMutateMessage(session: LiveSession, msg: any) {
  const exchangeId = String(msg.exchangeId ?? "");
  // Invariant #1: the exchange is looked up server-side, from this session's own buffer or
  // (Ticket 0.3) durable storage — the client never supplies the request/headers itself,
  // only a reference to a previously broadcast exchange.
  const exchange = await resolveExchange(session, exchangeId);
  if (!exchange) {
    broadcast(session, {
      type: "experimentError",
      exchangeId,
      error: "Unknown exchange — it may have scrolled out of the buffer.",
    });
    return;
  }
  const candidate: ResourceIdCandidate = {
    location: msg.location === "query" ? "query" : "path",
    paramName: String(msg.paramName ?? ""),
    value: "",
  };
  const requestJson = { location: candidate.location, paramName: candidate.paramName, newValue: String(msg.newValue ?? "") };
  try {
    // Invariants #2-#4 are enforced inside runIdMutationExperiment itself, not here.
    const result = await runIdMutationExperiment(exchange, candidate, String(msg.newValue ?? ""), session.scope);
    broadcast(session, {
      type: "experimentResult",
      exchangeId: exchange.id,
      baseline: clientExchange(result.baseline),
      mutatedResult: result.mutatedResult,
      diff: result.diff,
    });
    persistMutationOrReplayResult(session, exchange, "mutation", requestJson, result);
  } catch (err: any) {
    broadcast(session, { type: "experimentError", exchangeId: exchange.id, error: err?.message ?? String(err) });
    persistExperimentError(session, exchange, "mutation", requestJson, err);
  }
}

async function handleReplayMessage(session: LiveSession, msg: any) {
  const exchangeId = String(msg.exchangeId ?? "");
  const exchange = await resolveExchange(session, exchangeId);
  if (!exchange) {
    broadcast(session, {
      type: "experimentError",
      exchangeId,
      error: "Unknown exchange - it may have scrolled out of the buffer.",
    });
    return;
  }

  try {
    const result = await runReplayExperiment(exchange, session.scope);
    broadcast(session, {
      type: "experimentResult",
      experimentKind: "replay",
      exchangeId: exchange.id,
      baseline: clientExchange(result.baseline),
      mutatedResult: result.mutatedResult,
      diff: result.diff,
    });
    persistMutationOrReplayResult(session, exchange, "replay", undefined, result);
  } catch (err: any) {
    broadcast(session, { type: "experimentError", exchangeId: exchange.id, error: err?.message ?? String(err) });
    persistExperimentError(session, exchange, "replay", undefined, err);
  }
}

async function handleSecurityTestMessage(session: LiveSession, msg: any) {
  const exchangeId = String(msg.exchangeId ?? "");
  const exchange = await resolveExchange(session, exchangeId);
  if (!exchange) {
    broadcast(session, {
      type: "securityTestError",
      exchangeId,
      error: "Unknown exchange - it may have scrolled out of the buffer.",
    });
    return;
  }

  try {
    const result = await runLiveSecurityTests(exchange, session.scope, {
      browserCorsRead: (url, timeoutMs) => runCachedBrowserCorsReadProbe(session, url, timeoutMs),
      browserCorsReadAttempts: 1,
    });
    broadcast(session, {
      type: "securityTestResult",
      exchangeId: exchange.id,
      result,
    });
    persistSecurityTestResult(session, exchange, result);
  } catch (err: any) {
    broadcast(session, { type: "securityTestError", exchangeId: exchange.id, error: err?.message ?? String(err) });
    persistExperimentError(session, exchange, "securityTest", undefined, err);
  }
}

function handleAllowHostMessage(session: LiveSession, msg: any) {
  const host = String(msg.host ?? "").trim().toLowerCase();
  if (!host || !session.observedHosts.has(host)) {
    broadcast(session, {
      type: "scopeError",
      host,
      error: "Host must be observed in this live browser session before it can be authorized.",
    });
    return;
  }
  if (!session.scope.allowedHosts.map((h) => h.toLowerCase()).includes(host)) {
    session.scope.allowedHosts = [...session.scope.allowedHosts, host];
  }
  broadcast(session, { type: "scope", ...scopeSnapshot(session) });
}

export async function handleClientMessage(session: LiveSession, raw: string) {
  let msg: any;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  try {
    if (msg.type === "mouse") {
      session.lastInputAt = Date.now();
      await dispatchMouseInput(session.cdp, msg);
    } else if (msg.type === "key") {
      session.lastInputAt = Date.now();
      await dispatchKeyInput(session.cdp, msg);
    } else if (msg.type === "allowHost") {
      handleAllowHostMessage(session, msg);
    } else if (msg.type === "automationPacing") {
      setAutomatedScanPacing(session, msg);
    } else if (msg.type === "replay") {
      await handleReplayMessage(session, msg);
    } else if (msg.type === "securityTest") {
      await handleSecurityTestMessage(session, msg);
    } else if (msg.type === "siteWalk") {
      setAutomatedScanPacing(session, msg);
      runSafeRouteWalk(session, "manual").catch((err: any) => {
        console.warn(`[live-security-session] route walk failed for ${session.id}:`, err?.message ?? err);
        session.routeWalkRunning = false;
        broadcast(session, { type: "siteWalk", status: "failed", error: err?.message ?? String(err) });
      });
    } else if (msg.type === "mutate") {
      await handleMutateMessage(session, msg);
    } else if (msg.type === "stop") {
      await closeLiveSession(session.id);
    }
  } catch (err: any) {
    console.warn("[live-security-session] failed to handle client message:", err?.message ?? err);
  }
}

export function registerLiveSecuritySessionRoutes(app: FastifyInstance) {
  app.get("/security/auth-sessions/:id/live-test", { websocket: true }, async (socket: WebSocket, req) => {
    const { id } = req.params as { id: string };
    const { ticket } = req.query as { ticket?: string };

    if (!ticket || !consumeLiveTestTicket(id, ticket)) {
      socket.close(4001, "invalid or expired ticket");
      return;
    }

    const authSession = await prisma.securityAuthSession.findUnique({ where: { id } });
    if (!authSession) {
      socket.close(4004, "session not found");
      return;
    }
    // Hard gate, re-checked here even though the ticket-issuing route already checked it —
    // this WebSocket handler is the actual point where the live browser starts, so it must
    // not trust a ticket alone.
    if (authSession.status !== "captured" || !authSession.scopeAcknowledged) {
      socket.close(4003, "session is not ready for live testing (must be captured and scope-acknowledged)");
      return;
    }

    let session = active.get(id);
    if (!session) {
      try {
        session = await startLiveSession(authSession);
      } catch (err: any) {
        socket.send(JSON.stringify({ type: "status", status: "failed", error: err?.message ?? String(err) }));
        socket.close(1011, "failed to start live session");
        return;
      }
    }

    const liveSession = session;
    liveSession.sockets.add(socket);
    socket.send(JSON.stringify({ type: "ready", url: liveSession.page.url(), ...scopeSnapshot(liveSession) }));
    // A newly (re)connecting client should see traffic captured before it joined.
    for (const exchange of liveSession.exchanges) {
      socket.send(JSON.stringify({ type: "exchange", exchange: clientExchange(exchange) }));
    }

    socket.on("message", (data: WebSocket.RawData) => {
      handleClientMessage(liveSession, data.toString());
    });

    socket.on("close", () => {
      liveSession.sockets.delete(socket);
    });
  });
}
