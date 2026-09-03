import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { persistExchange, loadPersistedExchange } from "./live-security-persist.js";
import { LIVE_SECURITY_ROOT } from "../lib/storageRoots.js";

// Ticket 0.3 (durable exchange retrieval) — unit tests for loadPersistedExchange, the
// read-side counterpart to Ticket 0.2's persistExchange. Hits the real DB/disk the same way
// the earlier Ticket 0.2 scratch verification did; scoped under a throwaway
// Project/SecurityAuthSession, fully cleaned up per test.

const prisma = new PrismaClient();

async function withScratchSession(run: (authSessionId: string) => Promise<void>) {
  const user = await prisma.user.findFirst({ select: { id: true } });
  if (!user) throw new Error("No user found in DB to attach a scratch project to");
  const project = await prisma.project.create({
    data: { name: "scratch-ticket-0.3", repoUrl: "https://example.invalid/scratch", ownerId: user.id },
  });
  const authSession = await prisma.securityAuthSession.create({
    data: { projectId: project.id, mode: "bug_bounty", status: "captured" },
  });
  try {
    await run(authSession.id);
  } finally {
    await prisma.securityLiveExchange.deleteMany({ where: { authSessionId: authSession.id } });
    await prisma.securityAuthSession.delete({ where: { id: authSession.id } });
    await prisma.project.delete({ where: { id: project.id } });
    await fs.rm(path.join(LIVE_SECURITY_ROOT, authSession.id), { recursive: true, force: true });
  }
}

test.after(() => prisma.$disconnect());

test("loadPersistedExchange returns null for a completely unknown id (buffer miss + no durable row)", async () => {
  await withScratchSession(async (authSessionId) => {
    const result = await loadPersistedExchange(authSessionId, crypto.randomUUID());
    assert.equal(result, null);
  });
});

test("loadPersistedExchange rehydrates an inline-stored (small) body correctly", async () => {
  await withScratchSession(async (authSessionId) => {
    const id = crypto.randomUUID();
    await persistExchange({
      id,
      sessionId: authSessionId,
      timestamp: Date.now(),
      request: { method: "GET", url: "https://example.invalid/api/orders/1", headers: { "x-test": "1" } },
      response: { status: 200, headers: { "content-type": "application/json" }, body: '{"ok":true}', durationMs: 5 },
    });
    const loaded = await loadPersistedExchange(authSessionId, id);
    assert.ok(loaded, "expected the persisted exchange to be found");
    assert.equal(loaded!.request.method, "GET");
    assert.deepEqual(loaded!.request.headers, { "x-test": "1" });
    assert.equal(loaded!.response!.status, 200);
    assert.equal(loaded!.response!.body, '{"ok":true}');
  });
});

test("loadPersistedExchange rehydrates a disk-stored (large) body correctly", async () => {
  await withScratchSession(async (authSessionId) => {
    const id = crypto.randomUUID();
    const bigBody = "y".repeat(20_000); // exceeds the 8_000-char inline threshold
    await persistExchange({
      id,
      sessionId: authSessionId,
      timestamp: Date.now(),
      request: { method: "POST", url: "https://example.invalid/api/orders", headers: {}, postData: bigBody },
      response: { status: 201, headers: {}, body: bigBody, durationMs: 9 },
    });
    const loaded = await loadPersistedExchange(authSessionId, id);
    assert.ok(loaded, "expected the persisted exchange to be found");
    assert.equal(loaded!.response!.body, bigBody);
    assert.equal(loaded!.request.postData, bigBody);
  });
});

test("loadPersistedExchange rejects an exchange id that belongs to a different auth session", async () => {
  await withScratchSession(async (authSessionId) => {
    const id = crypto.randomUUID();
    await persistExchange({
      id,
      sessionId: authSessionId,
      timestamp: Date.now(),
      request: { method: "GET", url: "https://example.invalid/api/orders/1", headers: {} },
      response: { status: 200, headers: {}, body: "{}", durationMs: 1 },
    });
    const result = await loadPersistedExchange("some-other-session-id-entirely", id);
    assert.equal(result, null, "an exchange id from another session must not be usable");
  });
});

test("loadPersistedExchange fails gracefully (returns null) when the persisted body file is missing from disk", async () => {
  await withScratchSession(async (authSessionId) => {
    const id = crypto.randomUUID();
    const bigBody = "z".repeat(20_000);
    await persistExchange({
      id,
      sessionId: authSessionId,
      timestamp: Date.now(),
      request: { method: "GET", url: "https://example.invalid/api/orders/2", headers: {} },
      response: { status: 200, headers: {}, body: bigBody, durationMs: 1 },
    });
    // Simulate disk corruption/deletion after the DB row was written.
    await fs.rm(path.join(LIVE_SECURITY_ROOT, authSessionId, id), { recursive: true, force: true });
    const result = await loadPersistedExchange(authSessionId, id);
    assert.equal(result, null, "a missing body file must not throw — caller falls back to the existing error path");
  });
});
