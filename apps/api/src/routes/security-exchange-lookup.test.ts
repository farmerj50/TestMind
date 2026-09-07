import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { loadPersistedExchange } from "../runner/live-security-persist.js";
import { clientExchange } from "../security/live-exchange-serialize.js";

// Reproduction traceability, Ticket TRC.2: GET /security/auth-sessions/:id/exchanges/:exchangeId.
// index.ts can't be booted from a test (app.listen() unconditional at module scope) - this
// exercises the route's exact underlying call sequence (loadPersistedExchange, scoped by
// (exchangeId, authSessionId) together, then clientExchange() redaction) directly against a
// real DB, matching this session's established "test through the underlying calls" precedent.
// The route's own ownership check (project.ownerId === userId, checked before ever calling
// loadPersistedExchange) is a plain Prisma findFirst identical in shape to every other route in
// this file - not re-tested here, exercised instead via loadPersistedExchange's own
// (id, authSessionId) scoping, which is the actual cross-session isolation boundary.

const prisma = new PrismaClient();

async function seedSessionWithExchange(userId: string) {
  const project = await prisma.project.create({
    data: { name: "scratch-trc2", repoUrl: "https://example.invalid/scratch", ownerId: userId },
  });
  const authSession = await prisma.securityAuthSession.create({
    data: { projectId: project.id, mode: "bug_bounty" },
  });
  const exchangeId = crypto.randomUUID();
  await prisma.securityLiveExchange.create({
    data: {
      id: exchangeId,
      authSessionId: authSession.id,
      timestamp: new Date(),
      method: "GET",
      url: "https://example.invalid/api/orders/100",
      requestHeadersJson: { cookie: "session=real-secret-value", "x-custom": "ok" },
      responseStatus: 200,
      responseHeadersJson: { "content-type": "application/json" },
      responseBodyInline: JSON.stringify({ orderId: "100" }),
    },
  });
  return { project, authSession, exchangeId };
}

test.after(() => prisma.$disconnect());

test("TRC.2: loadPersistedExchange resolves an exchange scoped to its own auth session, and clientExchange redacts sensitive headers", async () => {
  const user = await prisma.user.findFirst({ select: { id: true } });
  if (!user) throw new Error("No user found in DB to attach a scratch project to");
  const { authSession, exchangeId } = await seedSessionWithExchange(user.id);

  try {
    const exchange = await loadPersistedExchange(authSession.id, exchangeId);
    assert.ok(exchange, "the exchange must resolve for its own session");
    const serialized = clientExchange(exchange!);
    assert.equal(serialized.request.headers["cookie"], "[REDACTED]", "sensitive headers must be redacted before reaching the client");
    assert.equal(serialized.request.headers["x-custom"], "ok", "non-sensitive headers must be left untouched");
  } finally {
    await prisma.securityLiveExchange.deleteMany({ where: { authSessionId: authSession.id } });
    await prisma.securityAuthSession.delete({ where: { id: authSession.id } });
    await prisma.project.delete({ where: { id: authSession.projectId } });
  }
});

test("TRC.2: an exchange id that exists but belongs to a DIFFERENT auth session resolves to null - indistinguishable from not existing at all", async () => {
  const user = await prisma.user.findFirst({ select: { id: true } });
  if (!user) throw new Error("No user found in DB to attach a scratch project to");
  const { authSession: sessionA, exchangeId } = await seedSessionWithExchange(user.id);
  const projectB = await prisma.project.create({
    data: { name: "scratch-trc2-b", repoUrl: "https://example.invalid/scratch-b", ownerId: user.id },
  });
  const sessionB = await prisma.securityAuthSession.create({ data: { projectId: projectB.id, mode: "bug_bounty" } });

  try {
    const crossSessionLookup = await loadPersistedExchange(sessionB.id, exchangeId);
    assert.equal(crossSessionLookup, null, "an exchange id from another session must resolve to null, not the real row");

    const genuinelyMissing = await loadPersistedExchange(sessionA.id, crypto.randomUUID());
    assert.equal(genuinelyMissing, null);

    // Both failure modes are the identical `null` - the route layer can't tell them apart and
    // therefore can't leak "this id exists, just not for you" as a distinct signal.
  } finally {
    await prisma.securityLiveExchange.deleteMany({ where: { authSessionId: sessionA.id } });
    await prisma.securityAuthSession.deleteMany({ where: { id: { in: [sessionA.id, sessionB.id] } } });
    await prisma.project.deleteMany({ where: { id: { in: [sessionA.projectId, projectB.id] } } });
  }
});
