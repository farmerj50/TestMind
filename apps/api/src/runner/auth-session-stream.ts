import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import type WebSocket from "ws";
import { chromium, type Browser, type BrowserContext, type Page, type CDPSession } from "playwright";
import { prisma } from "../prisma.js";
import { AUTH_SESSION_ROOT } from "../lib/storageRoots.js";
import { dispatchMouseInput, dispatchKeyInput } from "./live-input-forwarding.js";

// Bug Bounty mode: streams a live, server-side Chromium tab to the browser via
// CDP screencast frames over a WebSocket, and forwards the user's mouse/keyboard
// input back into the page via the CDP Input domain. Once the user logs in
// (detected via successPattern, or confirmed manually) the authenticated
// storageState is captured to disk and the SecurityAuthSession is marked "captured".

const TICKET_TTL_MS = 60_000;
const IDLE_TIMEOUT_MS = 10 * 60_000;
const VIEWPORT = { width: 1280, height: 800 };

type Ticket = {
  sessionId: string;
  expiresAt: number;
  allowInteractiveChallengeHandling: boolean;
  proxyUrl?: string;
};
const tickets = new Map<string, Ticket>();

export function issueStreamTicket(
  sessionId: string,
  allowInteractiveChallengeHandling = false,
  proxyUrl?: string,
): string {
  const ticket = crypto.randomBytes(24).toString("hex");
  tickets.set(ticket, { sessionId, expiresAt: Date.now() + TICKET_TTL_MS, allowInteractiveChallengeHandling, proxyUrl });
  return ticket;
}

function consumeStreamTicket(
  sessionId: string,
  ticket: string,
): { ok: boolean; allowInteractiveChallengeHandling: boolean; proxyUrl?: string } {
  const entry = tickets.get(ticket);
  if (!entry) return { ok: false, allowInteractiveChallengeHandling: false };
  tickets.delete(ticket);
  const ok = entry.expiresAt >= Date.now() && entry.sessionId === sessionId;
  return { ok, allowInteractiveChallengeHandling: entry.allowInteractiveChallengeHandling, proxyUrl: entry.proxyUrl };
}

// Spoofed client-IP headers used to probe whether the target's bot/IP-reputation
// manager blindly trusts client-supplied IP headers for reputation decisions instead
// of the actual TCP source — a standard IP-trust misconfiguration test for authorized
// engagements. Opt-in only (per-session), never sent by default.
const IP_TRUST_HEADERS: Record<string, string> = {
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
  allowInteractiveChallengeHandling: boolean,
  proxyUrl?: string,
): Promise<ActiveCapture> {
  const startUrl = session.loginUrl || session.baseUrl;
  if (!startUrl) throw new Error("Session has no baseUrl/loginUrl to navigate to");

  const browser = await chromium.launch({
    headless: false,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-sandbox",
      // When routing through an intercepting proxy (e.g. Burp Suite), Playwright Chromium
      // uses its own bundled cert store — NOT the Windows/system store — so it rejects the
      // proxy's self-signed CA even if the user has installed it system-wide. Suppress that
      // check only when a proxy is explicitly configured; the proxy itself does cert inspection.
      ...(proxyUrl ? ["--ignore-certificate-errors"] : []),
    ],
    ...(proxyUrl ? { proxy: { server: proxyUrl } } : {}),
  });
  if (proxyUrl) {
    console.log(`[auth-session-stream] outbound proxy set for session ${session.id}: ${proxyUrl} (cert errors suppressed)`);
  }
  const context = await browser.newContext({
    viewport: VIEWPORT,
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
  });
  // Suppress the full set of automation fingerprinting signals that bot managers check.
  // This mirrors what Burp's "Bypass Bot Detection" extension does: normalize every
  // browser property that Playwright-launched Chromium leaves in an obviously-automated
  // state, so the live view looks identical to a real user's Chrome session.
  // This callback is serialized by Playwright and executed inside the browser page context,
  // not in Node — hence globalThis (= window in the browser) and no-TypeScript-lib browser
  // globals. The casts to `any` are purely to satisfy tsc; at runtime these are real browser
  // objects.
  await context.addInitScript(() => {
    const win = globalThis as any;

    // 1. webdriver — the most obvious signal; --disable-blink-features=AutomationControlled
    //    isn't fully reliable on recent Chromium, so remove it JS-side too.
    Object.defineProperty(Navigator.prototype, "webdriver", { get: () => undefined });

    // 2. window.chrome — absent in Playwright-launched Chromium; many scripts check for
    //    chrome.runtime before deciding whether to show bot-detection challenges.
    if (!win.chrome) {
      win.chrome = {
        runtime: { connect: () => {}, sendMessage: () => {}, onMessage: { addListener: () => {} } },
        loadTimes: () => null,
        csi: () => null,
        app: {},
      };
    }

    // 3. navigator.plugins — empty in Playwright Chromium; real Chrome has at least three.
    Object.defineProperty(Navigator.prototype, "plugins", {
      get: () => {
        const list = [
          { name: "Chrome PDF Plugin", filename: "internal-pdf-viewer", description: "Portable Document Format" },
          { name: "Chrome PDF Viewer", filename: "mhjfbmdgcfjbbpaeojofohoefgiehjai", description: "" },
          { name: "Native Client", filename: "internal-nacl-plugin", description: "" },
        ];
        return Object.assign(list, {
          namedItem: (name: string) => list.find((p) => p.name === name) ?? null,
          refresh: () => {},
          item: (i: number) => list[i] ?? null,
          length: list.length,
          [Symbol.iterator]: [][Symbol.iterator],
        });
      },
    });

    // 4. navigator.languages — must be non-empty and match the Accept-Language header.
    Object.defineProperty(Navigator.prototype, "languages", { get: () => ["en-US", "en"] });

    // 5. navigator.userAgentData (Client Hints API) — checked by modern bot managers
    //    (Akamai Bot Manager, PerimeterX, DataDome, etc.) as a high-signal automation tell.
    const uaBrands = [
      { brand: "Chromium", version: "148" },
      { brand: "Google Chrome", version: "148" },
      { brand: "Not:A-Brand", version: "99" },
    ];
    const uaData = {
      brands: uaBrands,
      mobile: false,
      platform: "Windows",
      getHighEntropyValues: async (_hints: string[]) => ({
        architecture: "x86",
        bitness: "64",
        brands: uaBrands,
        fullVersionList: [
          { brand: "Chromium", version: "148.0.0.0" },
          { brand: "Google Chrome", version: "148.0.0.0" },
          { brand: "Not:A-Brand", version: "99.0.0.0" },
        ],
        mobile: false,
        model: "",
        platform: "Windows",
        platformVersion: "10.0.0",
        uaFullVersion: "148.0.0.0",
        wow64: false,
      }),
      toJSON: () => ({ brands: uaBrands, mobile: false, platform: "Windows" }),
    };
    Object.defineProperty(Navigator.prototype, "userAgentData", { get: () => uaData });

    // 6. permissions.query — headless Chrome returns detectable values for "notifications";
    //    normalise to what a real browser would report.
    const origQuery = win.navigator?.permissions?.query?.bind(win.navigator.permissions);
    if (origQuery) {
      win.navigator.permissions.query = (params: any) => {
        if (params?.name === "notifications") {
          return Promise.resolve({ state: win.Notification?.permission ?? "default" });
        }
        return origQuery(params);
      };
    }
  });

  // Only inject headers on top-level navigations, not on every request.
  // context.extraHTTPHeaders applies to XHR/fetch calls the page's own JS makes too —
  // non-CORS-safelisted headers on those requests fail CORS preflight and break the page's
  // real API calls (the "something went wrong" login failure seen earlier on justicepathlaw).
  await context.route("**/*", (route) => {
    const request = route.request();
    if (!request.isNavigationRequest()) return route.continue();
    return route.continue({
      headers: {
        ...request.headers(),
        "Accept-Language": "en-US,en;q=0.9",
        // Sec-CH-UA client hint headers — Chrome sends these on all navigation requests;
        // their absence is a fingerprinting signal for some bot managers.
        "Sec-CH-UA": '"Chromium";v="148", "Google Chrome";v="148", "Not:A-Brand";v="99"',
        "Sec-CH-UA-Mobile": "?0",
        "Sec-CH-UA-Platform": '"Windows"',
        ...(allowInteractiveChallengeHandling ? IP_TRUST_HEADERS : {}),
      },
    });
  });
  if (allowInteractiveChallengeHandling) {
    console.warn(`[auth-session-stream] IP-trust headers enabled for session ${session.id} — authorized-engagement-only mode`);
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
      await dispatchMouseInput(cdp, msg);
    } else if (msg.type === "key") {
      await dispatchKeyInput(cdp, msg);
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
    const { ok: ticketOk, allowInteractiveChallengeHandling, proxyUrl } = consumeStreamTicket(id, ticket);
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
        capture = await startCapture(session, allowInteractiveChallengeHandling, proxyUrl);
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
