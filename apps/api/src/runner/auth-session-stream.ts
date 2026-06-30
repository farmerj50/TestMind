import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import type WebSocket from "ws";
import { chromium, type Browser, type BrowserContext, type Page, type CDPSession } from "playwright";
import { prisma } from "../prisma.js";
import { AUTH_SESSION_ROOT } from "../lib/storageRoots.js";

// Bug Bounty mode: streams a live, server-side Chromium tab to the browser via
// CDP screencast frames over a WebSocket, and forwards the user's mouse/keyboard
// input back into the page via the CDP Input domain. Once the user logs in
// (detected via successPattern, or confirmed manually) the authenticated
// storageState is captured to disk and the SecurityAuthSession is marked "captured".

const TICKET_TTL_MS = 60_000;
const IDLE_TIMEOUT_MS = 10 * 60_000;
const VIEWPORT = { width: 1280, height: 800 };

type Ticket = { sessionId: string; expiresAt: number; attemptWafBypass: boolean };
const tickets = new Map<string, Ticket>();

export function issueStreamTicket(sessionId: string, attemptWafBypass = false): string {
  const ticket = crypto.randomBytes(24).toString("hex");
  tickets.set(ticket, { sessionId, expiresAt: Date.now() + TICKET_TTL_MS, attemptWafBypass });
  return ticket;
}

function consumeStreamTicket(sessionId: string, ticket: string): { ok: boolean; attemptWafBypass: boolean } {
  const entry = tickets.get(ticket);
  if (!entry) return { ok: false, attemptWafBypass: false };
  tickets.delete(ticket);
  const ok = entry.expiresAt >= Date.now() && entry.sessionId === sessionId;
  return { ok, attemptWafBypass: entry.attemptWafBypass };
}

// Spoofed client-IP headers used to probe whether the target's WAF/bot-manager
// blindly trusts client-supplied IP headers for reputation decisions instead of
// the actual TCP source — a standard WAF-misconfiguration test for authorized
// engagements. Opt-in only (per-session), never sent by default.
const WAF_BYPASS_HEADERS: Record<string, string> = {
  "X-Forwarded-For": "127.0.0.1",
  "X-Originating-IP": "127.0.0.1",
  "X-Remote-IP": "127.0.0.1",
  "X-Remote-Addr": "127.0.0.1",
  "X-Client-IP": "127.0.0.1",
  "X-Real-IP": "127.0.0.1",
  "True-Client-IP": "127.0.0.1",
  "CF-Connecting-IP": "127.0.0.1",
};

type ActiveCapture = {
  id: string;
  browser: Browser;
  context: BrowserContext;
  page: Page;
  cdp: CDPSession;
  sockets: Set<WebSocket>;
  pollHandle: NodeJS.Timeout;
  idleHandle: NodeJS.Timeout;
  closed: boolean;
};

const active = new Map<string, ActiveCapture>();

function broadcast(capture: ActiveCapture, payload: unknown) {
  const msg = JSON.stringify(payload);
  for (const ws of capture.sockets) {
    if (ws.readyState === ws.OPEN) ws.send(msg);
  }
}

async function setSessionStatus(sessionId: string, data: Record<string, unknown>) {
  try {
    await prisma.securityAuthSession.update({ where: { id: sessionId }, data });
  } catch (err: any) {
    console.warn(`[auth-session-stream] failed to update session ${sessionId} status:`, err?.message ?? err);
  }
}

async function closeCapture(sessionId: string, finalStatus?: { status: string; error?: string | null }) {
  const capture = active.get(sessionId);
  if (!capture || capture.closed) return;
  capture.closed = true;
  clearInterval(capture.pollHandle);
  clearTimeout(capture.idleHandle);
  active.delete(sessionId);
  for (const ws of capture.sockets) {
    try { ws.close(); } catch {}
  }
  try {
    await capture.browser.close();
  } catch {}
  if (finalStatus) await setSessionStatus(sessionId, finalStatus);
}

async function captureStorageState(capture: ActiveCapture) {
  const storageState = await capture.context.storageState();
  const filePath = path.join(AUTH_SESSION_ROOT, `${capture.id}.json`);
  await fs.writeFile(filePath, JSON.stringify(storageState), "utf8");
  const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000);
  broadcast(capture, { type: "status", status: "captured" });
  await closeCapture(capture.id, { status: "captured", error: null });
  await setSessionStatus(capture.id, { storagePath: filePath, expiresAt });
}

async function startCapture(
  session: {
    id: string;
    baseUrl: string | null;
    loginUrl: string | null;
    successPattern: string | null;
  },
  attemptWafBypass: boolean,
): Promise<ActiveCapture> {
  const startUrl = session.loginUrl || session.baseUrl;
  if (!startUrl) throw new Error("Session has no baseUrl/loginUrl to navigate to");

  const browser = await chromium.launch({
    headless: false,
    args: ["--disable-blink-features=AutomationControlled", "--no-sandbox"],
  });
  const context = await browser.newContext({
    viewport: VIEWPORT,
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
  });
  // --disable-blink-features=AutomationControlled is unreliable on recent Chromium —
  // explicitly override the navigator.webdriver flag JS-side, since some sites silently
  // reject form submissions (generic "something went wrong") when it reads true, even
  // when the fields visually filled in correctly.
  await context.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, "webdriver", { get: () => undefined });
  });
  // Only inject Accept-Language / WAF-bypass headers on top-level navigations, not on
  // every request. context.extraHTTPHeaders would apply to XHR/fetch calls the page's
  // own JS makes (e.g. its login API call) too — those headers aren't CORS-safelisted,
  // so the target's CORS preflight rejects them and the real login request never goes
  // through, surfacing as a generic client-side "something went wrong".
  await context.route("**/*", (route) => {
    const request = route.request();
    if (!request.isNavigationRequest()) return route.continue();
    return route.continue({
      headers: {
        ...request.headers(),
        "Accept-Language": "en-US,en;q=0.9",
        ...(attemptWafBypass ? WAF_BYPASS_HEADERS : {}),
      },
    });
  });
  if (attemptWafBypass) {
    console.warn(`[auth-session-stream] WAF-bypass headers enabled for session ${session.id} — authorized-engagement-only mode`);
  }
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);

  const capture: ActiveCapture = {
    id: session.id,
    browser,
    context,
    page,
    cdp,
    sockets: new Set(),
    pollHandle: setInterval(() => {}, 60_000),
    idleHandle: setTimeout(() => {}, IDLE_TIMEOUT_MS),
    closed: false,
  };
  active.set(session.id, capture);

  cdp.on("Page.screencastFrame", (frame: any) => {
    broadcast(capture, { type: "frame", data: frame.data, mimeType: "jpeg" });
    cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => {});
  });

  await page.goto(startUrl, { waitUntil: "domcontentloaded" }).catch((err: any) => {
    console.warn(`[auth-session-stream] initial navigation failed for ${session.id}:`, err?.message ?? err);
  });

  await cdp.send("Page.startScreencast", {
    format: "jpeg",
    quality: 60,
    maxWidth: VIEWPORT.width,
    maxHeight: VIEWPORT.height,
    everyNthFrame: 1,
  });

  clearInterval(capture.pollHandle);
  if (session.successPattern?.trim()) {
    const pattern = session.successPattern.trim().toLowerCase();
    capture.pollHandle = setInterval(() => {
      if (capture.closed) return;
      if (page.url().toLowerCase().includes(pattern)) {
        captureStorageState(capture).catch((err) =>
          console.warn(`[auth-session-stream] auto-capture failed for ${session.id}:`, (err as any)?.message ?? err),
        );
      }
    }, 1500);
  }

  clearTimeout(capture.idleHandle);
  capture.idleHandle = setTimeout(() => {
    closeCapture(session.id, { status: "expired", error: "Session capture timed out without completing login" }).catch(() => {});
  }, IDLE_TIMEOUT_MS);

  return capture;
}

const SPECIAL_KEYS: Record<string, { code: string; windowsVirtualKeyCode: number }> = {
  Enter: { code: "Enter", windowsVirtualKeyCode: 13 },
  Backspace: { code: "Backspace", windowsVirtualKeyCode: 8 },
  Tab: { code: "Tab", windowsVirtualKeyCode: 9 },
  Escape: { code: "Escape", windowsVirtualKeyCode: 27 },
  Delete: { code: "Delete", windowsVirtualKeyCode: 46 },
  ArrowLeft: { code: "ArrowLeft", windowsVirtualKeyCode: 37 },
  ArrowUp: { code: "ArrowUp", windowsVirtualKeyCode: 38 },
  ArrowRight: { code: "ArrowRight", windowsVirtualKeyCode: 39 },
  ArrowDown: { code: "ArrowDown", windowsVirtualKeyCode: 40 },
  " ": { code: "Space", windowsVirtualKeyCode: 32 },
};

async function handleClientMessage(capture: ActiveCapture, raw: string) {
  let msg: any;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  const cdp = capture.cdp;
  try {
    if (msg.type === "mouse") {
      const x = Number(msg.x) || 0;
      const y = Number(msg.y) || 0;
      if (msg.event === "move") {
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      } else if (msg.event === "down") {
        await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: msg.button || "left", clickCount: 1 });
      } else if (msg.event === "up") {
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: msg.button || "left", clickCount: 1 });
      } else if (msg.event === "wheel") {
        await cdp.send("Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x,
          y,
          deltaX: Number(msg.deltaX) || 0,
          deltaY: Number(msg.deltaY) || 0,
        });
      }
    } else if (msg.type === "key" && msg.event === "down") {
      const key = String(msg.key ?? "");
      if (key.length === 1) {
        // Dispatch a real keyDown/keyUp pair (with `text` set) rather than Input.insertText.
        // insertText bypasses keydown/keyup entirely, which behavioral bot-detection (and some
        // CSRF/anti-automation form handlers) can use to flag the submission as non-human even
        // though the field visually fills in correctly.
        await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", text: key, unmodifiedText: key, key });
        await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key });
      } else {
        const mapped = SPECIAL_KEYS[key];
        if (mapped) {
          await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key, code: mapped.code, windowsVirtualKeyCode: mapped.windowsVirtualKeyCode });
          await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key, code: mapped.code, windowsVirtualKeyCode: mapped.windowsVirtualKeyCode });
        }
      }
    } else if (msg.type === "capture") {
      await captureStorageState(capture);
    }
  } catch (err: any) {
    console.warn("[auth-session-stream] failed to forward input event:", err?.message ?? err);
  }
}

export function registerAuthSessionStreamRoutes(app: FastifyInstance) {
  app.get("/security/auth-sessions/:id/stream", { websocket: true }, async (socket: WebSocket, req) => {
    const { id } = req.params as { id: string };
    const { ticket } = req.query as { ticket?: string };

    if (!ticket) {
      socket.close(4001, "invalid or expired ticket");
      return;
    }
    const { ok: ticketOk, attemptWafBypass } = consumeStreamTicket(id, ticket);
    if (!ticketOk) {
      socket.close(4001, "invalid or expired ticket");
      return;
    }

    const session = await prisma.securityAuthSession.findUnique({ where: { id } });
    if (!session) {
      socket.close(4004, "session not found");
      return;
    }

    let capture = active.get(id);
    if (!capture) {
      try {
        capture = await startCapture(session, attemptWafBypass);
        await setSessionStatus(id, { status: "pending", error: null });
      } catch (err: any) {
        const message = err?.message ?? String(err);
        socket.send(JSON.stringify({ type: "status", status: "failed", error: message }));
        await setSessionStatus(id, { status: "failed", error: message });
        socket.close(1011, "failed to start capture");
        return;
      }
    }

    const liveCapture = capture;
    liveCapture.sockets.add(socket);
    socket.send(JSON.stringify({ type: "ready", url: liveCapture.page.url() }));

    socket.on("message", (data: WebSocket.RawData) => {
      handleClientMessage(liveCapture, data.toString());
    });

    socket.on("close", () => {
      liveCapture.sockets.delete(socket);
    });
  });
}
