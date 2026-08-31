import crypto from "node:crypto";
import fs from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import type WebSocket from "ws";
// patchright, not playwright — see auth-session-stream.ts for why (Runtime.enable CDP
// leak fix; scoped to the two files that attach a live CDP session).
import { chromium, type Browser, type BrowserContext, type Page, type CDPSession } from "patchright";
import { prisma } from "../prisma.js";
import { dispatchMouseInput, dispatchKeyInput } from "./live-input-forwarding.js";
import { runIdMutationExperiment, runReplayExperiment } from "../security/experiment.js";
import { runLiveSecurityTests } from "../security/live-security-tests.js";
import type { SecurityHttpExchange, ResourceIdCandidate } from "../security/http-exchange.js";
import type { ProbeScope } from "../security/http-client.js";

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
const MAX_BUFFERED_EXCHANGES = 200;
const ACTION_CORRELATION_WINDOW_MS = 2_000;
const MAX_ROUTE_WALK_PAGES = 25;
const SENSITIVE_HEADER_RE =
  /^(authorization|cookie|set-cookie|proxy-authorization|x-api-key|api-key|x-auth-token|x-session|x-session-id|x-csrf-token|x-xsrf-token)$/i;
const DANGEROUS_ROUTE_RE =
  /(logout|log-out|signout|sign-out|delete|remove|destroy|deactivate|close-account|cancel|billing|checkout|payment|purchase|subscribe|transfer|withdraw)/i;

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
  pendingRequests: Map<string, PendingRequest>; // keyed by CDP requestId
  pendingRequestExtraHeaders: Map<string, Record<string, string>>; // keyed by CDP requestId
  pendingResponses: Map<string, PendingResponse>;
  routeWalkSeen: Set<string>;
  routeWalkRunning: boolean;
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

function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = SENSITIVE_HEADER_RE.test(key) ? "[REDACTED]" : value;
  }
  return out;
}

function clientExchange(exchange: SecurityHttpExchange): SecurityHttpExchange {
  return {
    ...exchange,
    request: {
      ...exchange.request,
      headers: redactHeaders(exchange.request.headers),
    },
    response: exchange.response
      ? {
          ...exchange.response,
          headers: redactHeaders(exchange.response.headers),
        }
      : undefined,
  };
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

function pushExchange(session: LiveSession, exchange: SecurityHttpExchange) {
  session.exchanges.push(exchange);
  session.exchangesById.set(exchange.id, exchange);
  if (session.exchanges.length > MAX_BUFFERED_EXCHANGES) {
    const removed = session.exchanges.shift();
    if (removed) session.exchangesById.delete(removed.id);
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

function isSafeRouteWalkTarget(baseUrl: string, candidate: { url: string; text: string }) {
  try {
    const base = new URL(baseUrl);
    const url = new URL(candidate.url);
    if (url.origin !== base.origin) return false;
    if (isStaticPath(url.pathname)) return false;
    const signal = `${url.pathname} ${url.search} ${candidate.text}`.toLowerCase();
    return !DANGEROUS_ROUTE_RE.test(signal);
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
    if (session.routeWalkSeen.has(normalized)) continue;
    if (!isSafeRouteWalkTarget(session.baseUrl, { ...candidate, url: normalized })) continue;
    session.routeWalkSeen.add(normalized);
    targets.push(normalized);
  }
  return targets;
}

async function runSafeRouteWalk(session: LiveSession, reason: "initial" | "manual" = "manual") {
  if (session.routeWalkRunning || session.closed) return;
  session.routeWalkRunning = true;
  const originalUrl = session.page.url();
  let visited = 0;
  broadcast(session, { type: "siteWalk", status: "running", reason, visited, limit: MAX_ROUTE_WALK_PAGES });

  try {
    const queue = await collectSafeRouteWalkTargets(session);
    while (queue.length > 0 && visited < MAX_ROUTE_WALK_PAGES && !session.closed) {
      const nextUrl = queue.shift();
      if (!nextUrl) continue;
      visited += 1;
      broadcast(session, { type: "siteWalk", status: "visiting", url: nextUrl, visited, limit: MAX_ROUTE_WALK_PAGES });
      await session.page.goto(nextUrl, { waitUntil: "domcontentloaded", timeout: 12_000 }).catch(() => null);
      await session.page.waitForLoadState("networkidle", { timeout: 1_500 }).catch(() => null);

      const discovered = await collectSafeRouteWalkTargets(session);
      for (const target of discovered) {
        if (visited + queue.length >= MAX_ROUTE_WALK_PAGES) break;
        queue.push(target);
      }
    }
  } finally {
    if (!session.closed) {
      await session.page.goto(originalUrl, { waitUntil: "domcontentloaded", timeout: 12_000 }).catch(() => null);
    }
    session.routeWalkRunning = false;
    broadcast(session, { type: "siteWalk", status: "done", reason, visited, limit: MAX_ROUTE_WALK_PAGES });
  }
}

export async function closeLiveSession(id: string): Promise<void> {
  const session = active.get(id);
  if (!session || session.closed) return;
  session.closed = true;
  clearTimeout(session.idleHandle);
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
    pendingRequests: new Map(),
    pendingRequestExtraHeaders: new Map(),
    pendingResponses: new Map(),
    routeWalkSeen: new Set(),
    routeWalkRunning: false,
    lastInputAt: 0,
    idleHandle: setTimeout(() => {
      closeLiveSession(authSession.id).catch(() => {});
    }, IDLE_TIMEOUT_MS),
    closed: false,
  };
  active.set(authSession.id, session);

  cdp.on("Page.screencastFrame", (frame: any) => {
    broadcast(session, { type: "frame", data: frame.data, mimeType: "jpeg" });
    cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => {});
  });

  await cdp.send("Network.enable");

  cdp.on("Network.requestWillBeSent", (evt: any) => {
    observeHost(session, evt.request.url);
    const extraHeaders = session.pendingRequestExtraHeaders.get(evt.requestId) ?? {};
    session.pendingRequests.set(evt.requestId, {
      method: evt.request.method,
      url: evt.request.url,
      headers: mergeHeaders(normalizeHeaders(evt.request.headers), extraHeaders),
      postData: evt.request.postData,
      timestamp: Date.now(),
    });
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
  });

  cdp.on("Network.responseReceived", (evt: any) => {
    session.pendingResponses.set(evt.requestId, {
      status: evt.response.status,
      headers: normalizeHeaders(evt.response.headers),
    });
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

    let body: string | undefined;
    try {
      const bodyResult: any = await cdp.send("Network.getResponseBody", { requestId: evt.requestId });
      if (!bodyResult.base64Encoded) body = bodyResult.body;
    } catch {
      // Body may be unavailable (redirect, opaque response, already-evicted from CDP's
      // buffer) — still record the exchange without it.
    }

    const exchange: SecurityHttpExchange = {
      id: crypto.randomUUID(),
      sessionId: session.id,
      timestamp: pendingRequest.timestamp,
      request: {
        method: pendingRequest.method,
        url: pendingRequest.url,
        headers: pendingRequest.headers,
        postData: pendingRequest.postData,
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

async function handleMutateMessage(session: LiveSession, msg: any) {
  const exchangeId = String(msg.exchangeId ?? "");
  // Invariant #1: the exchange is looked up server-side, from this session's own buffer —
  // the client never supplies the request/headers itself, only a reference to a previously
  // broadcast exchange.
  const exchange = session.exchangesById.get(exchangeId);
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
  } catch (err: any) {
    broadcast(session, { type: "experimentError", exchangeId: exchange.id, error: err?.message ?? String(err) });
  }
}

async function handleReplayMessage(session: LiveSession, msg: any) {
  const exchangeId = String(msg.exchangeId ?? "");
  const exchange = session.exchangesById.get(exchangeId);
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
  } catch (err: any) {
    broadcast(session, { type: "experimentError", exchangeId: exchange.id, error: err?.message ?? String(err) });
  }
}

async function handleSecurityTestMessage(session: LiveSession, msg: any) {
  const exchangeId = String(msg.exchangeId ?? "");
  const exchange = session.exchangesById.get(exchangeId);
  if (!exchange) {
    broadcast(session, {
      type: "securityTestError",
      exchangeId,
      error: "Unknown exchange - it may have scrolled out of the buffer.",
    });
    return;
  }

  try {
    const result = await runLiveSecurityTests(exchange, session.scope);
    broadcast(session, {
      type: "securityTestResult",
      exchangeId: exchange.id,
      result,
    });
  } catch (err: any) {
    broadcast(session, { type: "securityTestError", exchangeId: exchange.id, error: err?.message ?? String(err) });
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
    } else if (msg.type === "replay") {
      await handleReplayMessage(session, msg);
    } else if (msg.type === "securityTest") {
      await handleSecurityTestMessage(session, msg);
    } else if (msg.type === "siteWalk") {
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
