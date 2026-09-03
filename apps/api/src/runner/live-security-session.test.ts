import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { handleClientMessage, setCaptureDegraded, checkBacklogWatermark, pushExchange } from "./live-security-session.js";
import { persistExchange, getPersistQueueDepth, waitForPersistQueueIdle } from "./live-security-persist.js";
import { listExchangeHistory } from "../security/live-exchange-history.js";
import { LIVE_SECURITY_ROOT } from "../lib/storageRoots.js";
import type { SecurityHttpExchange } from "../security/http-exchange.js";
import type { ProbeScope } from "../security/http-client.js";

// Ticket 0.3 (durable exchange retrieval) — integration tests through the real
// handleClientMessage entry point, proving the mutate/replay/securityTest handlers still
// work exactly as before for an in-memory hit, AND now also succeed when the exchange has
// been intentionally kept OUT of session.exchangesById and only exists in durable storage.
// Deeper invariant coverage (GET-only, candidate validation, etc.) already lives in
// security/experiment.test.ts and security/live-security-tests.test.ts — these tests only
// exercise the retrieval/rehydration seam this ticket adds.

const prisma = new PrismaClient();

async function withLocalServer(run: (base: string, port: number) => Promise<void>) {
  const server = http.createServer((req, res) => {
    const match = req.url?.match(/^\/api\/orders\/(\w+)/);
    if (match) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: match[1], ownerId: match[1] === "8721" ? 413 : 900 }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as any).port as number;
  try {
    await run(`http://127.0.0.1:${port}`, port);
  } finally {
    server.close();
  }
}

async function withScratchAuthSession(run: (authSessionId: string) => Promise<void>) {
  const user = await prisma.user.findFirst({ select: { id: true } });
  if (!user) throw new Error("No user found in DB to attach a scratch project to");
  const project = await prisma.project.create({
    data: { name: "scratch-ticket-0.3-session", repoUrl: "https://example.invalid/scratch", ownerId: user.id },
  });
  const authSession = await prisma.securityAuthSession.create({
    data: { projectId: project.id, mode: "bug_bounty", status: "captured" },
  });
  try {
    await run(authSession.id);
  } finally {
    // Ticket 0.5: experiment persistence is fire-and-forget via the same queue as exchange
    // persistence — wait for it to drain before deleting FK-dependent rows, or a still-
    // in-flight write can land after cleanup and violate the SecurityAuthSession FK.
    await waitForPersistQueueIdle();
    await prisma.securityLiveExperiment.deleteMany({ where: { authSessionId: authSession.id } });
    await prisma.securityLiveExchange.deleteMany({ where: { authSessionId: authSession.id } });
    await prisma.securityAuthSession.delete({ where: { id: authSession.id } });
    await prisma.project.delete({ where: { id: project.id } });
    await fs.rm(path.join(LIVE_SECURITY_ROOT, authSession.id), { recursive: true, force: true });
  }
}

function makeFakeSession(authSessionId: string, scope: ProbeScope) {
  const messages: any[] = [];
  const ws = { readyState: 1, OPEN: 1, send: (raw: string) => messages.push(JSON.parse(raw)) };
  const session: any = {
    id: authSessionId,
    baseUrl: "https://example.invalid",
    sockets: new Set([ws]),
    scope,
    exchanges: [],
    exchangesById: new Map<string, SecurityHttpExchange>(),
    persistedSnippetIds: new Set<string>(),
    effectiveMaxBufferedExchanges: 400,
    captureDegraded: false,
    degradedByBacklog: false,
    degradedByMemory: false,
    browserCorsProofCache: new Map(),
    browserCorsProofInFlight: new Map(),
    browserCorsProofCount: 0,
    routeWalkSeen: new Set(),
    routeWalkRunning: false,
    routeWalkPausedByRateLimit: false,
    rateLimitSignals: [],
    automatedScanDelayMs: 0,
    lastInputAt: 0,
    closed: false,
  };
  return { session, messages };
}

test.after(() => prisma.$disconnect());

test("in-memory hit still follows the existing path (no durable row exists at all)", async () => {
  await withLocalServer(async (base, port) => {
    await withScratchAuthSession(async (authSessionId) => {
      const exchange: SecurityHttpExchange = {
        id: crypto.randomUUID(),
        sessionId: authSessionId,
        timestamp: Date.now(),
        request: { method: "GET", url: `${base}/api/orders/8721`, headers: {} },
        response: { status: 200, headers: {}, body: '{"id":"8721","ownerId":413}', durationMs: 5 },
      };
      const { session, messages } = makeFakeSession(authSessionId, { allowedHosts: ["127.0.0.1"], allowedPorts: [port] });
      session.exchangesById.set(exchange.id, exchange); // in-memory only — nothing persisted to DB

      await handleClientMessage(
        session,
        JSON.stringify({ type: "mutate", exchangeId: exchange.id, location: "path", paramName: "segment2", newValue: "9999" })
      );

      assert.equal(messages.length, 1);
      assert.equal(messages[0].type, "experimentResult", `expected success, got: ${JSON.stringify(messages[0])}`);
    });
  });
});

test("mutation works against a persistently rehydrated baseline (exchange kept out of the in-memory buffer)", async () => {
  await withLocalServer(async (base, port) => {
    await withScratchAuthSession(async (authSessionId) => {
      const exchangeId = crypto.randomUUID();
      await persistExchange({
        id: exchangeId,
        sessionId: authSessionId,
        timestamp: Date.now(),
        request: { method: "GET", url: `${base}/api/orders/8721`, headers: {} },
        response: { status: 200, headers: {}, body: '{"id":"8721","ownerId":413}', durationMs: 5 },
      });
      const { session, messages } = makeFakeSession(authSessionId, { allowedHosts: ["127.0.0.1"], allowedPorts: [port] });
      // Deliberately NOT added to session.exchangesById — must be resolved from durable storage.

      await handleClientMessage(
        session,
        JSON.stringify({ type: "mutate", exchangeId, location: "path", paramName: "segment2", newValue: "9999" })
      );

      assert.equal(messages.length, 1);
      assert.equal(messages[0].type, "experimentResult", `expected success, got: ${JSON.stringify(messages[0])}`);
      assert.equal(messages[0].mutatedResult.status, 200);
    });
  });
});

test("replay works against a persistently rehydrated baseline (exchange kept out of the in-memory buffer)", async () => {
  await withLocalServer(async (base, port) => {
    await withScratchAuthSession(async (authSessionId) => {
      const exchangeId = crypto.randomUUID();
      await persistExchange({
        id: exchangeId,
        sessionId: authSessionId,
        timestamp: Date.now(),
        request: { method: "GET", url: `${base}/api/orders/8721`, headers: {} },
        response: { status: 200, headers: {}, body: '{"id":"8721","ownerId":413}', durationMs: 5 },
      });
      const { session, messages } = makeFakeSession(authSessionId, { allowedHosts: ["127.0.0.1"], allowedPorts: [port] });

      await handleClientMessage(session, JSON.stringify({ type: "replay", exchangeId }));

      assert.equal(messages.length, 1);
      assert.equal(messages[0].type, "experimentResult", `expected success, got: ${JSON.stringify(messages[0])}`);
      assert.equal(messages[0].mutatedResult.url, `${base}/api/orders/8721`);
    });
  });
});

test("security testing works against a persistently rehydrated baseline (exchange kept out of the in-memory buffer)", async () => {
  await withLocalServer(async (base, port) => {
    await withScratchAuthSession(async (authSessionId) => {
      const exchangeId = crypto.randomUUID();
      // No cookie header -> the browser-CORS-read branch of runLiveSecurityTests is never
      // triggered, so this test doesn't need a real browser/page.
      await persistExchange({
        id: exchangeId,
        sessionId: authSessionId,
        timestamp: Date.now(),
        request: { method: "GET", url: `${base}/api/orders/8721`, headers: { Authorization: "Bearer captured-token" } },
        response: { status: 200, headers: { "content-type": "application/json" }, body: '{"id":"8721","ownerId":413}', durationMs: 5 },
      });
      const { session, messages } = makeFakeSession(authSessionId, { allowedHosts: ["127.0.0.1"], allowedPorts: [port] });

      await handleClientMessage(session, JSON.stringify({ type: "securityTest", exchangeId }));

      assert.equal(messages.length, 1);
      assert.equal(messages[0].type, "securityTestResult", `expected success, got: ${JSON.stringify(messages[0])}`);
      assert.ok(Array.isArray(messages[0].result.checks));
    });
  });
});

test("an unknown exchange id (no memory hit, no durable row) still produces the existing error broadcast", async () => {
  await withScratchAuthSession(async (authSessionId) => {
    const { session, messages } = makeFakeSession(authSessionId, { allowedHosts: ["127.0.0.1"], allowedPorts: [1] });
    await handleClientMessage(session, JSON.stringify({ type: "mutate", exchangeId: crypto.randomUUID(), location: "path", paramName: "x", newValue: "1" }));
    assert.equal(messages.length, 1);
    assert.equal(messages[0].type, "experimentError");
    assert.match(messages[0].error, /Unknown exchange/);
  });
});

// Ticket 0.4 (bound memory) — direct tests of the new degrade/watermark/snippet-shrink
// machinery. setCaptureDegraded/checkBacklogWatermark/pushExchange are exported purely for
// this testability (no other caller outside this module) — none of their real call sites
// (checkMemoryPressure's setInterval, the Network.loadingFinished handler) changed.

function makeExchange(id: string, overrides: Partial<SecurityHttpExchange> = {}): SecurityHttpExchange {
  return {
    id,
    sessionId: "s1",
    timestamp: Date.now(),
    request: { method: "GET", url: "https://example.invalid/api/x", headers: {} },
    response: { status: 200, headers: {}, body: "{}", durationMs: 1 },
    ...overrides,
  };
}

test("setCaptureDegraded('persist backlog', true) sets the combined flag and broadcasts once on the edge", () => {
  const { session, messages } = makeFakeSession("s1", { allowedHosts: [], allowedPorts: [] });
  setCaptureDegraded(session, "persist backlog", true);
  assert.equal(session.degradedByBacklog, true);
  assert.equal(session.captureDegraded, true);
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0], { type: "captureThrottled", reason: "persist backlog", active: true });
});

test("setCaptureDegraded('persist backlog', false) after true clears the combined flag and broadcasts recovery", () => {
  const { session, messages } = makeFakeSession("s1", { allowedHosts: [], allowedPorts: [] });
  setCaptureDegraded(session, "persist backlog", true);
  setCaptureDegraded(session, "persist backlog", false);
  assert.equal(session.captureDegraded, false);
  assert.equal(messages.length, 2);
  assert.deepEqual(messages[1], { type: "captureThrottled", reason: "persist backlog", active: false });
});

test("setCaptureDegraded('memory pressure', true) halves the effective buffer cap and evicts down to it", () => {
  const { session } = makeFakeSession("s1", { allowedHosts: [], allowedPorts: [] });
  for (let i = 0; i < 250; i += 1) {
    const ex = makeExchange(`ex-${i}`);
    session.exchanges.push(ex);
    session.exchangesById.set(ex.id, ex);
  }
  assert.equal(session.effectiveMaxBufferedExchanges, 400);

  setCaptureDegraded(session, "memory pressure", true);

  assert.equal(session.effectiveMaxBufferedExchanges, 200); // MAX_BUFFERED_EXCHANGES (400) / 2
  assert.equal(session.exchanges.length, 200, "eviction should have run immediately down to the new cap");
  assert.equal(session.exchangesById.size, 200);
});

test("setCaptureDegraded('memory pressure', false) restores the full buffer cap", () => {
  const { session } = makeFakeSession("s1", { allowedHosts: [], allowedPorts: [] });
  setCaptureDegraded(session, "memory pressure", true);
  assert.equal(session.effectiveMaxBufferedExchanges, 200);
  setCaptureDegraded(session, "memory pressure", false);
  assert.equal(session.effectiveMaxBufferedExchanges, 400);
});

test("two independent degrade reasons combine correctly: clearing one while the other is still active keeps captureDegraded true and does not re-broadcast", () => {
  const { session, messages } = makeFakeSession("s1", { allowedHosts: [], allowedPorts: [] });
  setCaptureDegraded(session, "persist backlog", true); // messages[0]
  setCaptureDegraded(session, "memory pressure", true); // combined flag already true -> no new broadcast
  assert.equal(messages.length, 1);
  setCaptureDegraded(session, "persist backlog", false); // memory pressure still active -> combined flag stays true, no broadcast
  assert.equal(session.captureDegraded, true);
  assert.equal(messages.length, 1);
  setCaptureDegraded(session, "memory pressure", false); // now both clear -> broadcasts recovery
  assert.equal(session.captureDegraded, false);
  assert.equal(messages.length, 2);
});

test("checkBacklogWatermark does not degrade a session when the shared persist queue is below the high watermark", () => {
  const { session } = makeFakeSession("s1", { allowedHosts: [], allowedPorts: [] });
  assert.ok(getPersistQueueDepth() < 1_000, "test process's real persist queue should be idle/near-idle");
  checkBacklogWatermark(session);
  assert.equal(session.degradedByBacklog, false);
  assert.equal(session.captureDegraded, false);
});

test("pushExchange shrinks the in-memory body/postData to a redacted snippet once persistence completes, and marks the id", async () => {
  await withScratchAuthSession(async (authSessionId) => {
    const bigBody = "w".repeat(20_000);
    const exchange = makeExchange(crypto.randomUUID(), {
      sessionId: authSessionId,
      request: { method: "POST", url: "https://example.invalid/api/x", headers: {}, postData: bigBody },
      response: { status: 200, headers: {}, body: bigBody, durationMs: 1 },
    });
    const { session } = makeFakeSession(authSessionId, { allowedHosts: [], allowedPorts: [] });

    pushExchange(session, exchange);
    assert.equal(session.persistedSnippetIds.has(exchange.id), false, "snippet marker should not be set before persistence completes");

    // Persistence is enqueued asynchronously (Ticket 0.4's concurrency-bounded queue) — poll
    // briefly for it to land rather than assuming a fixed delay.
    const deadline = Date.now() + 5_000;
    while (!session.persistedSnippetIds.has(exchange.id) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    assert.equal(session.persistedSnippetIds.has(exchange.id), true, "exchange should be marked persisted");
    assert.ok(exchange.response!.body!.length < bigBody.length, "response body should have been shrunk to a snippet");
    assert.ok(exchange.request.postData!.length < bigBody.length, "request postData should have been shrunk to a snippet");
  });
});

test("resolveExchange (via handleClientMessage) reloads full data from durable storage for a snippet-marked in-memory hit", async () => {
  await withLocalServer(async (base, port) => {
    await withScratchAuthSession(async (authSessionId) => {
      const exchangeId = crypto.randomUUID();
      const exchange = makeExchange(exchangeId, {
        sessionId: authSessionId,
        request: { method: "GET", url: `${base}/api/orders/8721`, headers: {} },
        response: { status: 200, headers: {}, body: '{"id":"8721","ownerId":413}', durationMs: 5 },
      });
      const { session, messages } = makeFakeSession(authSessionId, { allowedHosts: ["127.0.0.1"], allowedPorts: [port] });

      // Persist for real, then simulate what pushExchange's onPersisted callback does: shrink
      // the in-memory copy and mark it, WITHOUT actually removing it from exchangesById — the
      // scenario Ticket 0.4 has to get right is "still in memory, but body is now a snippet."
      await persistExchange(exchange);
      session.exchangesById.set(exchangeId, exchange);
      exchange.response!.body = "SNIPPET-ONLY-NOT-REAL-JSON";
      session.persistedSnippetIds.add(exchangeId);

      await handleClientMessage(
        session,
        JSON.stringify({ type: "mutate", exchangeId, location: "path", paramName: "segment2", newValue: "9999" })
      );

      assert.equal(messages.length, 1);
      assert.equal(messages[0].type, "experimentResult", `expected success (using rehydrated real body), got: ${JSON.stringify(messages[0])}`);
      // If this had used the in-memory snippet directly, the mutation experiment's candidate
      // detection would have operated on garbage JSON and diffed against it incorrectly.
      assert.equal(messages[0].baseline.response.body, '{"id":"8721","ownerId":413}');
    });
  });
});

// Ticket 0.6 (Phase 0 certification) — the "reload/reconnect" and "no silent persistence
// loss" done-when criteria, proven together end-to-end: real capture volume large enough to
// force real eviction (not a manually-removed single exchange, as in the tests above), then a
// simulated reload (a fresh REST fetch with zero reliance on any in-memory state) recovers the
// complete history. Moderate scale (2x the buffer cap) here — the formal 50,000-exchange
// volume/heap-bound proof is a separate scripted run, not part of the regular suite.
test(
  "captures exceeding the in-memory buffer remain fully recoverable via REST history after eviction (reload/reconnect proof)",
  { timeout: 60_000 },
  async () => {
    await withScratchAuthSession(async (authSessionId) => {
      const { session } = makeFakeSession(authSessionId, { allowedHosts: [], allowedPorts: [] });
      const COUNT = 800; // > effectiveMaxBufferedExchanges (400) — forces real eviction, not a no-op
      const ids: string[] = [];
      for (let i = 0; i < COUNT; i += 1) {
        const ex = makeExchange(crypto.randomUUID(), {
          sessionId: authSessionId,
          request: { method: "GET", url: `https://example.invalid/api/item/${i}`, headers: {} },
          response: { status: 200, headers: {}, body: `{"i":${i}}`, durationMs: 1 },
        });
        ids.push(ex.id);
        pushExchange(session, ex);
      }

      assert.ok(session.exchanges.length < COUNT, "eviction should actually have happened for this to be a real test");
      assert.ok(session.exchanges.length <= session.effectiveMaxBufferedExchanges);

      await waitForPersistQueueIdle(30_000);

      // "Reload": brand-new queries with no reference to `session` at all — exactly what
      // hydrateHistory() on the client does after a page remount. listExchangeHistory caps at
      // 500/page by design (matches the client's own MAX_RETAINED_EXCHANGES), so recovering
      // all 800 requires paging back with `before`, same as the client would for deep history.
      const allRecovered: string[] = [];
      let before: string | undefined;
      let totalCount = 0;
      for (let guard = 0; guard < 10; guard += 1) {
        const page = await listExchangeHistory(authSessionId, { limit: 500, before });
        totalCount = page.totalCount;
        allRecovered.unshift(...page.exchanges.map((e) => e.request.url));
        if (!page.nextCursor) break;
        before = page.nextCursor;
      }
      assert.equal(totalCount, COUNT, "no silent persistence loss across the full capture volume");
      assert.equal(allRecovered.length, COUNT);
      assert.deepEqual(
        new Set(allRecovered),
        new Set(ids.map((_, i) => `https://example.invalid/api/item/${i}`)),
        "every captured exchange, including ones evicted from memory, must be present"
      );

      // The earliest-captured exchanges are the ones eviction would have removed first
      // (oldest non-candidate) — confirm at least the very first one really left memory, so
      // this test is actually exercising the eviction path, not accidentally passing because
      // nothing was evicted.
      assert.equal(session.exchangesById.has(ids[0]), false);
    });
  }
);
