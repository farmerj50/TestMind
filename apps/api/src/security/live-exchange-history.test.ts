import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { listExchangeHistory, listExperimentHistory } from "./live-exchange-history.js";
import { persistExchange, persistExperiment, waitForPersistQueueIdle } from "../runner/live-security-persist.js";
import { LIVE_SECURITY_ROOT } from "../lib/storageRoots.js";

// Ticket 0.5 (UI history recovery) — tests the pagination/serialization logic directly
// (HTTP-agnostic; no Fastify+Clerk auth-mocking harness exists in this repo), matching the
// established pattern from Ticket 0.3's loadPersistedExchange tests.

const prisma = new PrismaClient();

async function withScratchAuthSession(run: (authSessionId: string) => Promise<void>) {
  const user = await prisma.user.findFirst({ select: { id: true } });
  if (!user) throw new Error("No user found in DB to attach a scratch project to");
  const project = await prisma.project.create({
    data: { name: "scratch-ticket-0.5-history", repoUrl: "https://example.invalid/scratch", ownerId: user.id },
  });
  const authSession = await prisma.securityAuthSession.create({
    data: { projectId: project.id, mode: "bug_bounty", status: "captured" },
  });
  try {
    await run(authSession.id);
  } finally {
    await waitForPersistQueueIdle();
    await prisma.securityLiveExperiment.deleteMany({ where: { authSessionId: authSession.id } });
    await prisma.securityLiveExchange.deleteMany({ where: { authSessionId: authSession.id } });
    await prisma.securityAuthSession.delete({ where: { id: authSession.id } });
    await prisma.project.delete({ where: { id: project.id } });
    await fs.rm(path.join(LIVE_SECURITY_ROOT, authSession.id), { recursive: true, force: true });
  }
}

test.after(() => prisma.$disconnect());

test("listExchangeHistory returns exchanges oldest-first with a correct totalCount", async () => {
  await withScratchAuthSession(async (authSessionId) => {
    for (let i = 0; i < 3; i += 1) {
      await persistExchange({
        id: crypto.randomUUID(),
        sessionId: authSessionId,
        timestamp: Date.now(),
        request: { method: "GET", url: `https://example.invalid/api/${i}`, headers: {} },
        response: { status: 200, headers: {}, body: `{"i":${i}}`, durationMs: 1 },
      });
    }
    const page = await listExchangeHistory(authSessionId, {});
    assert.equal(page.totalCount, 3);
    assert.equal(page.exchanges.length, 3);
    assert.deepEqual(
      page.exchanges.map((e) => e.request.url),
      ["https://example.invalid/api/0", "https://example.invalid/api/1", "https://example.invalid/api/2"],
      "should be oldest-first"
    );
    assert.equal(page.nextCursor, null, "fewer rows than the limit means there's nothing further back");
  });
});

test("listExchangeHistory redacts sensitive headers exactly like the WS clientExchange() path", async () => {
  await withScratchAuthSession(async (authSessionId) => {
    await persistExchange({
      id: crypto.randomUUID(),
      sessionId: authSessionId,
      timestamp: Date.now(),
      request: { method: "GET", url: "https://example.invalid/api/x", headers: { Authorization: "Bearer secret-token" } },
      response: { status: 200, headers: { "Set-Cookie": "session=abc" }, body: "{}", durationMs: 1 },
    });
    const page = await listExchangeHistory(authSessionId, {});
    assert.equal(page.exchanges[0].request.headers.Authorization, "[REDACTED]");
    assert.equal(page.exchanges[0].response!.headers["Set-Cookie"], "[REDACTED]");
  });
});

test("listExchangeHistory paginates with a seq cursor as a string, not a raw BigInt", async () => {
  await withScratchAuthSession(async (authSessionId) => {
    for (let i = 0; i < 5; i += 1) {
      await persistExchange({
        id: crypto.randomUUID(),
        sessionId: authSessionId,
        timestamp: Date.now(),
        request: { method: "GET", url: `https://example.invalid/api/${i}`, headers: {} },
        response: { status: 200, headers: {}, body: "{}", durationMs: 1 },
      });
    }
    const firstPage = await listExchangeHistory(authSessionId, { limit: 2 });
    assert.equal(firstPage.exchanges.length, 2);
    assert.equal(typeof firstPage.nextCursor, "string");
    // JSON.stringify must not throw — proves nextCursor really is a string, not a BigInt.
    assert.doesNotThrow(() => JSON.stringify(firstPage));

    const secondPage = await listExchangeHistory(authSessionId, { limit: 2, before: firstPage.nextCursor! });
    assert.equal(secondPage.exchanges.length, 2);
    const allUrls = [...secondPage.exchanges, ...firstPage.exchanges].map((e) => e.request.url);
    assert.equal(new Set(allUrls).size, 4, "no overlap between pages");
  });
});

test("listExchangeHistory rejects a malformed before cursor", async () => {
  await withScratchAuthSession(async (authSessionId) => {
    await assert.rejects(() => listExchangeHistory(authSessionId, { before: "not-a-number" }));
  });
});

test("listExchangeHistory only returns exchanges for the given auth session", async () => {
  await withScratchAuthSession(async (authSessionId) => {
    await persistExchange({
      id: crypto.randomUUID(),
      sessionId: authSessionId,
      timestamp: Date.now(),
      request: { method: "GET", url: "https://example.invalid/api/mine", headers: {} },
      response: { status: 200, headers: {}, body: "{}", durationMs: 1 },
    });
    await withScratchAuthSession(async (otherAuthSessionId) => {
      await persistExchange({
        id: crypto.randomUUID(),
        sessionId: otherAuthSessionId,
        timestamp: Date.now(),
        request: { method: "GET", url: "https://example.invalid/api/other", headers: {} },
        response: { status: 200, headers: {}, body: "{}", durationMs: 1 },
      });
      const page = await listExchangeHistory(authSessionId, {});
      assert.equal(page.totalCount, 1);
      assert.equal(page.exchanges[0].request.url, "https://example.invalid/api/mine");
    });
  });
});

test("listExperimentHistory returns persisted mutation/replay/securityTest rows with rehydrated large result bodies", async () => {
  await withScratchAuthSession(async (authSessionId) => {
    const bigBody = "q".repeat(20_000);
    await persistExperiment({
      authSessionId,
      baselineUrl: "https://example.invalid/api/orders/1",
      baselineMethod: "GET",
      kind: "mutation",
      requestJson: { location: "path", paramName: "segment2", newValue: "9999" },
      resultStatus: 200,
      resultBody: bigBody,
      diffJson: { statusMatch: true, changedKeys: ["id"] },
    });
    await persistExperiment({
      authSessionId,
      baselineUrl: "https://example.invalid/api/orders/1",
      baselineMethod: "GET",
      kind: "securityTest",
      securityTestResultJson: { checks: [{ id: "route-context", status: "info" }] },
    });

    const page = await listExperimentHistory(authSessionId, {});
    assert.equal(page.experiments.length, 2);
    assert.deepEqual(
      page.experiments.map((e) => e.kind),
      ["mutation", "securityTest"],
      "oldest-first"
    );
    assert.equal(page.experiments[0].resultBody, bigBody, "large result body should have been rehydrated from disk");
    assert.deepEqual(page.experiments[0].diffJson, { statusMatch: true, changedKeys: ["id"] });
    assert.deepEqual(page.experiments[1].securityTestResultJson, { checks: [{ id: "route-context", status: "info" }] });
  });
});

test("listExperimentHistory records a failed experiment's error", async () => {
  await withScratchAuthSession(async (authSessionId) => {
    await persistExperiment({
      authSessionId,
      baselineUrl: "https://example.invalid/api/orders/1",
      baselineMethod: "GET",
      kind: "replay",
      error: "target host not in scope",
    });
    const page = await listExperimentHistory(authSessionId, {});
    assert.equal(page.experiments[0].error, "target host not in scope");
    assert.equal(page.experiments[0].resultBody, null);
  });
});
