import crypto from "node:crypto";
import fs from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import type WebSocket from "ws";
// patchright, not playwright — see auth-session-stream.ts for why (Runtime.enable CDP
// leak fix; scoped to the two files that attach a live CDP session).
import { chromium, type Browser, type BrowserContext, type Page, type CDPSession } from "patchright";
import { prisma } from "../prisma.js";
import { dispatchMouseInput, dispatchKeyInput } from "./live-input-forwarding.js";
import { runIdMutationExperiment } from "../security/experiment.js";
import type { SecurityHttpExchange, ResourceIdCandidate } from "../security/http-exchange.js";
import type { ProbeScope } from "../security/http-client.js";

// Live Security Testing v0.1 (POC) — a person drives a real, already-authenticated
// browser session (resumed from a captured SecurityAuthSession's storageState) exactly
// like they already do in Bug Bounty auth capture (auth-session-stream.ts); this session
// additionally captures the resulting HTTP traffic via the CDP Network domain and lets
// the user replay one captured GET request with a single mutated resource-ID candidate.
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
  browser: Browser;
  context: BrowserContext;
  page: Page;
  cdp: CDPSession;
  sockets: Set<WebSocket>;
  scope: ProbeScope;
  exchanges: SecurityHttpExchange[]; // ring buffer, oldest evicted first
  exchangesById: Map<string, SecurityHttpExchange>;
  pendingRequests: Map<string, PendingRequest>; // keyed by CDP requestId
  pendingResponses: Map<string, PendingResponse>;
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

function pushExchange(session: LiveSession, exchange: SecurityHttpExchange) {
  session.exchanges.push(exchange);
  session.exchangesById.set(exchange.id, exchange);
  if (session.exchanges.length > MAX_BUFFERED_EXCHANGES) {
    const removed = session.exchanges.shift();
    if (removed) session.exchangesById.delete(removed.id);
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
    browser,
    context,
    page,
    cdp,
    sockets: new Set(),
    scope: { allowedHosts: [hostname], allowedPorts: [] },
    exchanges: [],
    exchangesById: new Map(),
    pendingRequests: new Map(),
    pendingResponses: new Map(),
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
    session.pendingRequests.set(evt.requestId, {
      method: evt.request.method,
      url: evt.request.url,
      headers: evt.request.headers ?? {},
      postData: evt.request.postData,
      timestamp: Date.now(),
    });
  });

  cdp.on("Network.responseReceived", (evt: any) => {
    session.pendingResponses.set(evt.requestId, {
      status: evt.response.status,
      headers: evt.response.headers ?? {},
    });
  });

  // Request failed before a response arrived (blocked, aborted, network error) — nothing
  // useful to show in the traffic panel for v0.1; just clear the pending state.
  cdp.on("Network.loadingFailed", (evt: any) => {
    session.pendingRequests.delete(evt.requestId);
    session.pendingResponses.delete(evt.requestId);
  });

  cdp.on("Network.loadingFinished", async (evt: any) => {
    const pendingRequest = session.pendingRequests.get(evt.requestId);
    const pendingResponse = session.pendingResponses.get(evt.requestId);
    session.pendingRequests.delete(evt.requestId);
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
    broadcast(session, { type: "exchange", exchange });
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
      baseline: result.baseline,
      mutatedResult: result.mutatedResult,
      diff: result.diff,
    });
  } catch (err: any) {
    broadcast(session, { type: "experimentError", exchangeId: exchange.id, error: err?.message ?? String(err) });
  }
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
    socket.send(JSON.stringify({ type: "ready", url: liveSession.page.url() }));
    // A newly (re)connecting client should see traffic captured before it joined.
    for (const exchange of liveSession.exchanges) {
      socket.send(JSON.stringify({ type: "exchange", exchange }));
    }

    socket.on("message", (data: WebSocket.RawData) => {
      handleClientMessage(liveSession, data.toString());
    });

    socket.on("close", () => {
      liveSession.sockets.delete(socket);
    });
  });
}
