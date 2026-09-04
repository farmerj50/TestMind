import test from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import { applyApplicationModelMerge, MergeConflictError, MAX_MERGE_RETRIES } from "./application-model-store.js";
import { computeApiUpdate, computeIdentityUpdate, computeApplicationModelUpdate, upsertTestLink } from "./application-model.js";

// Ticket AB.1 - integration tests for the CAS-safe read-merge-write helper, against the real
// DB (this module touches Prisma directly, unlike application-model.ts's pure-function tests).
// Matches the withScratchAuthSession-style fixture pattern established in Phase 0.

const prisma = new PrismaClient();

async function withScratchProject(run: (projectId: string) => Promise<void>) {
  const user = await prisma.user.findFirst({ select: { id: true } });
  if (!user) throw new Error("No user found in DB to attach a scratch project to");
  const project = await prisma.project.create({
    data: { name: "scratch-application-brain", repoUrl: "https://example.invalid/scratch", ownerId: user.id },
  });
  try {
    await run(project.id);
  } finally {
    await prisma.project.delete({ where: { id: project.id } });
  }
}

test.after(() => prisma.$disconnect());

test("applyApplicationModelMerge writes the merged store and increments applicationModelVersion", async () => {
  await withScratchProject(async (projectId) => {
    const result = await applyApplicationModelMerge(projectId, (store) =>
      computeIdentityUpdate(store, { admin: { role: "admin" } }, "2026-01-01T00:00:00.000Z")
    );
    assert.ok(result.identities.admin);

    const row = await prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { applicationModelVersion: true } });
    assert.equal(row.applicationModelVersion, 1);
  });
});

test("applyApplicationModelMerge never clobbers a concurrent writer's change: retries by rereading the fresh value and reapplying mergeFn, not by rewriting the stale pre-conflict result", async () => {
  await withScratchProject(async (projectId) => {
    let calls = 0;
    const result = await applyApplicationModelMerge(projectId, async (store) => {
      calls += 1;
      if (calls === 1) {
        // Simulate a concurrent writer landing between our read and write: a second, fully
        // independent merge that lands for real (via its own applyApplicationModelMerge call)
        // while this mergeFn invocation is still "in flight" from the outer call's
        // perspective. This bumps applicationModelVersion underneath the outer call, forcing
        // its CAS to miss.
        await applyApplicationModelMerge(projectId, (s) =>
          computeApiUpdate(s, { "GET /concurrent": { method: "GET", path: "/concurrent" } }, "2026-01-01T00:00:00.000Z")
        );
      }
      return computeIdentityUpdate(store, { admin: { role: "admin" } }, "2026-01-01T00:00:00.000Z");
    });

    assert.ok(calls >= 2, "mergeFn must be re-invoked against fresh state after a CAS conflict, not retried with the stale computed result");
    assert.ok(result.apis["GET /concurrent"], "the concurrent writer's change must survive - proves the retry rereads rather than overwriting");
    assert.ok(result.identities.admin, "this call's own change must also land");

    // Confirm both changes are actually persisted, not just present in the returned value.
    const row = await prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { applicationModel: true } });
    const persisted = row.applicationModel as any;
    assert.ok(persisted.apis["GET /concurrent"]);
    assert.ok(persisted.identities.admin);
  });
});

test("applyApplicationModelMerge throws a typed MergeConflictError after exhausting its retry budget, rather than silently dropping the merge", async () => {
  await withScratchProject(async (projectId) => {
    let calls = 0;
    await assert.rejects(
      () =>
        applyApplicationModelMerge(projectId, async (store) => {
          calls += 1;
          // A hostile concurrent writer that lands on every single attempt, so the CAS never
          // succeeds within the retry budget.
          await prisma.project.update({ where: { id: projectId }, data: { applicationModelVersion: { increment: 1 } } });
          return computeIdentityUpdate(store, { admin: { role: "admin" } }, "2026-01-01T00:00:00.000Z");
        }),
      (err: unknown) => err instanceof MergeConflictError
    );
    assert.equal(calls, MAX_MERGE_RETRIES, "should have retried the full budget before giving up");
  });
});

test("applyApplicationModelMerge throws a plain error (not MergeConflictError) for a project that doesn't exist", async () => {
  await assert.rejects(
    () => applyApplicationModelMerge("does-not-exist", (store) => store),
    (err: unknown) => err instanceof Error && !(err instanceof MergeConflictError)
  );
});

// Ticket AB.4 - "all four producers write correctly under concurrent load ... verified by a
// test that fires several producers concurrently against one project and confirms every merge
// either lands in the final store or produces a logged MergeConflictError - never silently
// disappears unaccounted for." Each producer's actual route handler pulls in a lot of
// unrelated machinery (HTTP fetch, Playwright crawling, OpenAPI parsing) that would make this
// test fragile and slow for no added confidence - what actually matters here is that the CAS
// helper itself, under real concurrent writers shaped exactly like each producer's merge, never
// drops a concurrent writer's change. So this fires one applyApplicationModelMerge call per
// producer shape (page/form merge, testLink upsert, API merge, identity merge) at the same
// project simultaneously via Promise.allSettled, then asserts every one of them is accounted
// for - either landed in the final store, or is a logged MergeConflictError.
test("four producer-shaped merges firing concurrently at the same project: every one lands or is a typed MergeConflictError, never silently lost", async () => {
  await withScratchProject(async (projectId) => {
    const nowIso = "2026-01-01T00:00:00.000Z";
    const producers = [
      () => applyApplicationModelMerge(projectId, (store) => computeApplicationModelUpdate(store, { "/checkout": [{ selector: "#pay", fields: [{ name: "cardNumber" }] }] }, nowIso).next),
      () => applyApplicationModelMerge(projectId, (store) => upsertTestLink(store, "case-ab4", "/checkout", nowIso)),
      () => applyApplicationModelMerge(projectId, (store) => computeApiUpdate(store, { "POST /api/orders": { method: "POST", path: "/api/orders" } }, nowIso)),
      () => applyApplicationModelMerge(projectId, (store) => computeIdentityUpdate(store, { admin: { role: "admin" } }, nowIso)),
    ];

    const results = await Promise.allSettled(producers.map((run) => run()));

    for (const result of results) {
      if (result.status === "rejected") {
        assert.ok(result.reason instanceof MergeConflictError, "any failure must be the typed MergeConflictError, never an opaque/unaccounted-for failure");
      }
    }

    const row = await prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { applicationModel: true } });
    const finalStore = row.applicationModel as any;
    const landedCount = [
      "/checkout" in finalStore.pages,
      "case-ab4" in finalStore.testLinks,
      "POST /api/orders" in finalStore.apis,
      "admin" in finalStore.identities,
    ].filter(Boolean).length;
    const succeededCount = results.filter((r) => r.status === "fulfilled").length;
    assert.equal(landedCount, succeededCount, "every merge reported as fulfilled must actually be present in the persisted store");
    // With only 4 concurrent writers and a retry budget of 5 (MAX_MERGE_RETRIES), every writer
    // is guaranteed to eventually see a version where it's the last one pending - so all four
    // must land, not just "at least one." A flake here would mean the CAS helper's retry logic
    // regressed, not that this test is inherently racy.
    assert.equal(succeededCount, 4, "all four producer-shaped merges must land under this level of concurrency, given the retry budget");
  });
});
