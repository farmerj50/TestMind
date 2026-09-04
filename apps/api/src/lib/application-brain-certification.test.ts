import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { getApplicationBrainSnapshot } from "./application-brain-query.js";
import { applyApplicationModelMerge, MergeConflictError } from "./application-model-store.js";
import {
  computeApplicationModelUpdate,
  computeApiUpdate,
  computeIdentityUpdate,
  upsertTestLink,
  setWorkflow,
  applyLinksTo,
} from "./application-model.js";

// Ticket AB.5 - certification. Per the frozen contract: "no new product code, unless a test
// exposes a bug that must be fixed." This file adds no library/route code, only a test that
// seeds a realistically-shaped project (the same fact shapes each AB.4 producer writes,
// exercised at the same library entry points those producers call - see AB.1-AB.4's own tests
// for why HTTP/crawl/parse machinery is deliberately not re-exercised here) and certifies that
// all 7 "done when" questions are answerable from GET .../application-brain alone, without
// rediscovery/re-scan/re-run of anything. getApplicationBrainSnapshot is read-only by
// construction (see application-brain-query.ts's own header comment and imports - it imports
// only prisma and application-model.js, nothing from testmind/discover.ts, url-inspector.ts,
// or the security scanner modules), so there is no discovery/scan/run code path this test could
// even accidentally trigger.

const prisma = new PrismaClient();

async function withScratchProject(run: (projectId: string) => Promise<void>) {
  const user = await prisma.user.findFirst({ select: { id: true } });
  if (!user) throw new Error("No user found in DB to attach a scratch project to");
  const project = await prisma.project.create({
    data: { name: "scratch-ab5-certification", repoUrl: "https://example.invalid/scratch", ownerId: user.id },
  });
  try {
    await run(project.id);
  } finally {
    await prisma.securityFinding.deleteMany({ where: { scan: { projectId: project.id } } });
    await prisma.securityScanJob.deleteMany({ where: { projectId: project.id } });
    await prisma.testCase.deleteMany({ where: { projectId: project.id } });
    await prisma.project.delete({ where: { id: project.id } });
  }
}

test.after(() => prisma.$disconnect());

test("Ticket AB.5 certification: a realistically-seeded project answers all 7 done-when questions from persisted Brain data alone", async () => {
  await withScratchProject(async (projectId) => {
    const t0 = "2026-01-01T00:00:00.000Z";
    const t1 = "2026-01-02T00:00:00.000Z";

    // ── Cycle 1: simulates operator-worker.ts's discovery crawl finding two pages.
    await applyApplicationModelMerge(projectId, (s) =>
      computeApplicationModelUpdate(
        s,
        {
          "/login": [{ selector: "#login", fields: [{ name: "email" }, { name: "password" }] }],
          "/checkout": [{ selector: "#pay", fields: [{ name: "cardNumber" }] }],
        },
        t0
      ).next
    );
    await applyApplicationModelMerge(projectId, (s) => applyLinksTo(s, "/login", ["/checkout"]));

    // ── Cycle 2: /checkout is no longer observed (proves Q7 - "what changed since last run" -
    // without deleting it).
    await applyApplicationModelMerge(projectId, (s) =>
      computeApplicationModelUpdate(
        s,
        { "/login": [{ selector: "#login", fields: [{ name: "email" }, { name: "password" }] }] },
        t1
      ).next
    );

    // ── Simulates security.ts's ApiSpec import.
    await applyApplicationModelMerge(projectId, (s) =>
      computeApiUpdate(s, { "POST /api/orders": { method: "POST", path: "/api/orders" } }, t0)
    );

    // ── Simulates security.ts's auth-session role capture.
    await applyApplicationModelMerge(projectId, (s) => computeIdentityUpdate(s, { admin: { role: "admin" } }, t0));

    // ── Simulates AB.3's manually-authored workflow, covering both discovered pages.
    await applyApplicationModelMerge(projectId, (s) =>
      setWorkflow(s, "checkout", {
        name: "Checkout",
        riskTags: ["critical"],
        routeHints: ["/login", "/checkout"],
        apiHints: ["POST /api/orders"],
      })
    );

    // ── Simulates real QA runs: one TestCase per page, one passing, one failing.
    const passingCase = await prisma.testCase.create({
      data: { projectId, key: crypto.randomUUID(), title: "login works", lastResultStatus: "passed" },
    });
    const failingCase = await prisma.testCase.create({
      data: { projectId, key: crypto.randomUUID(), title: "checkout fails", lastResultStatus: "failed", lastFailureMessage: "500 on submit" },
    });
    // Simulates operator-worker.ts / url-inspector.ts's save flow writing testLinks at case
    // creation time.
    await applyApplicationModelMerge(projectId, (s) => upsertTestLink(s, passingCase.id, "/login", t1));
    await applyApplicationModelMerge(projectId, (s) => upsertTestLink(s, failingCase.id, "/checkout", t1));

    // ── Simulates a completed security scan: one URL-shaped finding (attributable), one
    // file:line finding (not attributable - code-review.ts's shape).
    const scan = await prisma.securityScanJob.create({ data: { projectId, status: "completed" } });
    await prisma.securityFinding.create({
      data: { scanId: scan.id, type: "dynamic", severity: "high", title: "IDOR on orders", location: "https://example.invalid/api/orders/1", tool: "idor-engine" },
    });
    await prisma.securityFinding.create({
      data: { scanId: scan.id, type: "static_analysis", severity: "medium", title: "hardcoded secret", location: "apps/api/src/index.ts:42", tool: "code-review" },
    });

    // ── AB.4's concurrent-write stress check, included here as a certification gate against
    // this same non-trivial, already-seeded store - not just an empty one like the AB.4 unit
    // test uses.
    const concurrentResults = await Promise.allSettled([
      applyApplicationModelMerge(projectId, (s) => computeApiUpdate(s, { "GET /api/health": { method: "GET", path: "/api/health" } }, t1)),
      applyApplicationModelMerge(projectId, (s) => computeIdentityUpdate(s, { user: { role: "user" } }, t1)),
      applyApplicationModelMerge(projectId, (s) => upsertTestLink(s, passingCase.id, "/login", t1)),
    ]);
    for (const result of concurrentResults) {
      if (result.status === "rejected") {
        assert.ok(result.reason instanceof MergeConflictError, "any concurrent failure must be the typed MergeConflictError, never silently unaccounted for");
      }
    }
    assert.equal(
      concurrentResults.filter((r) => r.status === "fulfilled").length,
      3,
      "all three concurrent merges must land against this project under this level of contention"
    );

    // ── Read back ONLY from the Brain's query layer - nothing above is re-run from here on.
    const snapshot = await getApplicationBrainSnapshot(projectId);

    // Q1: What does this application contain? (pages, with linksTo adjacency)
    assert.ok(snapshot.store.pages["/login"], "Q1: pages are known");
    assert.deepEqual(snapshot.store.pages["/login"].linksTo, ["/checkout"], "Q1: navigation adjacency is known");

    // Q2: What are the important workflows?
    assert.equal(snapshot.workflows.length, 1, "Q2: workflows are known");
    assert.equal(snapshot.workflows[0].name, "Checkout");
    assert.equal(snapshot.workflows[0].coveragePercent, 100, "Q2: workflow coverage is computed from real testLinks, not hand-waved");
    assert.equal(snapshot.workflows[0].observedApiHints, 1, "Q2: apiHints reported separately from routeHint coverage");

    // Q3: What APIs have been observed?
    assert.ok(snapshot.store.apis["POST /api/orders"], "Q3: APIs are known");
    assert.ok(snapshot.store.apis["GET /api/health"], "Q3: the concurrently-merged API also landed");

    // Q4: What identities/roles are known?
    assert.ok(snapshot.store.identities.admin, "Q4: identities are known");
    assert.ok(snapshot.store.identities.user, "Q4: the concurrently-merged identity also landed");

    // Q5: What has already been tested?
    const loginCoverage = snapshot.coverage.find((c) => c.testCaseId === passingCase.id);
    assert.equal(loginCoverage?.confidence, "linked", "Q5: coverage is known, with real (not inferred) confidence");
    assert.equal(loginCoverage?.routeHint, "/login");

    // Q6: What failed or produced findings before? Two distinct, separately-sourced fields.
    assert.equal(snapshot.qaFailures.length, 1);
    assert.equal(snapshot.qaFailures[0].testCaseId, failingCase.id);
    assert.equal(snapshot.securityFindings.attributed.length, 1);
    assert.equal(snapshot.securityFindings.attributed[0].routeHint, "/api/orders/1");
    assert.equal(snapshot.securityFindings.notAttributable.length, 1);
    assert.equal(snapshot.securityFindings.notAttributable[0].tool, "code-review");

    // Q7: What appears to have changed since the last run?
    assert.equal(snapshot.store.pages["/checkout"].consecutiveMisses, 1, "Q7: a page that stopped appearing is tracked as stale, not deleted");
    assert.equal(snapshot.store.pages["/login"].consecutiveMisses, 0, "Q7: a still-observed page's miss count stays at 0");
  });
});
