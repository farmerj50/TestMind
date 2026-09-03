import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { getApplicationBrainSnapshot } from "./application-brain-query.js";
import { applyApplicationModelMerge } from "./application-model-store.js";
import { computeApplicationModelUpdate, setWorkflow } from "./application-model.js";
import { rankWorkflowRisk, parseTopN, isValidAsOf, MAX_POSSIBLE_SCORE } from "./autonomous-planner.js";

// Ticket AP.4 - certification. Per the frozen contract, "no new product code unless a test
// exposes a bug." index.ts's GET /projects/:id/plan can never be imported/booted from a test
// (app.listen() runs unconditionally at module scope, and there's no Clerk test-auth bypass) -
// the user explicitly chose (see plan file) to certify by calling the exact same functions the
// route calls, in the same order, with the same inputs, rather than adding new boot/auth
// infrastructure. This mirrors AB.5's certification precedent, which also never hit HTTP.
//
// Also per the user's explicit choice: this file does NOT try to seed a single workflow that
// hits all 5 scoring dimensions at once for a real score of 110. That's structurally
// impossible against real data - coverageGap's 40pt max requires coveragePercent === 0 (no
// TestCase resolves to any of the workflow's routes), but qaFailures can only score a route
// that some TestCase DOES resolve to (the same coverage-join mechanism coverage[]/qaFailures[]
// both come from in AB.2's query layer) - so coverageGap=40 and qaFailures>0 can never coexist
// on one real workflow. securityFindings is unaffected (it joins on finding.location, not on
// any TestCase), so the realistic per-workflow ceiling is coverageGap(40) + securityFindings
// (30) + riskTags(5) + recentlyChanged(5) = 80, asserted exactly below. The exact all-5-
// dimensions MAX_POSSIBLE_SCORE (110) ceiling is already certified against an arbitrary/
// synthetic snapshot in autonomous-planner.test.ts, where it's actually reachable.

const prisma = new PrismaClient();

async function withScratchProject(run: (projectId: string) => Promise<void>) {
  const user = await prisma.user.findFirst({ select: { id: true } });
  if (!user) throw new Error("No user found in DB to attach a scratch project to");
  const project = await prisma.project.create({
    data: { name: "scratch-ap4-certification", repoUrl: "https://example.invalid/scratch", ownerId: user.id },
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

/** Reproduces GET /projects/:id/plan's exact body (index.ts) against real query-string-shaped
 * string inputs, without booting the server - see the file header for why. */
async function callPlanRoute(projectId: string, query: { topN?: string; objective?: string; asOf?: string }) {
  if (query.asOf !== undefined && !isValidAsOf(query.asOf)) {
    const err = new Error("asOf must be a complete ISO-8601 timestamp with an explicit timezone/offset") as Error & { statusCode: number };
    err.statusCode = 400;
    throw err;
  }
  const asOf = query.asOf ?? new Date().toISOString();
  const topN = parseTopN(query.topN);
  const objective = query.objective ?? null;

  const snapshot = await getApplicationBrainSnapshot(projectId);
  const { ranked, unrankable } = rankWorkflowRisk(snapshot, asOf, { topN });

  return {
    ranked,
    unrankable,
    notAttributableFindings: snapshot.securityFindings.notAttributable,
    objective,
    asOf,
  };
}

test("AP.4 certification: a realistically-seeded project produces the expected end-to-end ranking, scores, and ordering", async () => {
  await withScratchProject(async (projectId) => {
    const asOf = "2026-01-15T00:00:00.000Z";

    // ── "checkout": 0% coverage (no TestCase resolves to it - so 0 qaFailures is structural,
    // not an oversight), 3 critical attributed findings (36 raw -> capped 30), riskTags
    // present, page changed inside the 7-day window. Realistic per-workflow ceiling: 80.
    await applyApplicationModelMerge(projectId, (store) =>
      computeApplicationModelUpdate(store, { "/checkout": [{ selector: "#pay", fields: [{ name: "cardNumber" }] }] }, "2026-01-10T00:00:00.000Z").next
    );
    await applyApplicationModelMerge(projectId, (store) =>
      setWorkflow(store, "checkout", { name: "Checkout", riskTags: ["critical"], routeHints: ["/checkout"], apiHints: [] })
    );
    const checkoutScan = await prisma.securityScanJob.create({ data: { projectId, status: "completed" } });
    for (let i = 0; i < 3; i++) {
      await prisma.securityFinding.create({
        data: { scanId: checkoutScan.id, type: "dynamic", severity: "critical", title: `checkout finding ${i}`, location: "https://example.invalid/checkout", tool: "idor-engine" },
      });
    }

    // ── "settings": 1 of 2 declared routes covered (50%) via an inferred-confidence failing
    // case (contributes both coverage and qaFailures), 1 low-severity attributed finding, no
    // riskTags, page changed outside the 7-day window.
    await applyApplicationModelMerge(projectId, (store) =>
      computeApplicationModelUpdate(store, { "/settings": [{ selector: "#name", fields: [{ name: "displayName" }] }] }, "2026-01-01T00:00:00.000Z").next
    );
    await applyApplicationModelMerge(projectId, (store) =>
      setWorkflow(store, "settings", { name: "Settings", riskTags: [], routeHints: ["/settings", "/settings/billing"], apiHints: [] })
    );
    await prisma.testCase.create({
      data: {
        projectId,
        key: crypto.randomUUID(),
        title: "settings save fails",
        lastResultStatus: "failed",
        preconditions: JSON.stringify({ route: "/settings" }),
      },
    });
    const settingsScan = await prisma.securityScanJob.create({ data: { projectId, status: "completed" } });
    await prisma.securityFinding.create({
      data: { scanId: settingsScan.id, type: "dynamic", severity: "low", title: "minor info leak", location: "https://example.invalid/settings", tool: "cors-audit" },
    });

    // ── "empty-workflow": zero declared routeHints - must land in unrankable, never scored.
    await applyApplicationModelMerge(projectId, (store) =>
      setWorkflow(store, "empty-workflow", { name: "Empty", riskTags: [], routeHints: [], apiHints: [] })
    );

    // ── A non-URL-shaped finding - must appear in notAttributableFindings, never join to any
    // workflow's score.
    await prisma.securityFinding.create({
      data: { scanId: settingsScan.id, type: "static_analysis", severity: "critical", title: "hardcoded secret", location: "apps/api/src/index.ts:42", tool: "code-review" },
    });

    const response = await callPlanRoute(projectId, { asOf });

    assert.equal(response.asOf, asOf, "asOf must be echoed back unchanged");
    assert.equal(response.objective, null, "objective defaults to null when not supplied");

    assert.equal(response.ranked.length, 2, "checkout and settings are rankable; empty-workflow is not");
    const [first, second] = response.ranked;
    assert.equal(first.key, "checkout", "checkout's higher score must rank first");
    assert.equal(first.score, 80);
    assert.deepEqual(first.breakdown, { coverageGap: 40, qaFailures: 0, securityFindings: 30, riskTags: 5, recentlyChanged: 5 });
    assert.ok(first.score < MAX_POSSIBLE_SCORE, "80 is the realistic per-workflow ceiling, below the synthetic 110 ceiling");

    assert.equal(second.key, "settings");
    assert.equal(second.score, 27);
    assert.deepEqual(second.breakdown, { coverageGap: 20, qaFailures: 5, securityFindings: 2, riskTags: 0, recentlyChanged: 0 });

    assert.equal(response.unrankable.length, 1);
    assert.equal(response.unrankable[0].key, "empty-workflow");
    assert.equal(response.unrankable[0].reason, "no declared routeHints");

    assert.equal(response.notAttributableFindings.length, 1);
    assert.equal(response.notAttributableFindings[0].tool, "code-review");

    // ── Done when: two requests with the same asOf return byte-identical output.
    const response2 = await callPlanRoute(projectId, { asOf });
    assert.deepEqual(response, response2);
  });
});

test("AP.4 certification: an invalid asOf is rejected exactly as the route would reject it (400)", async () => {
  await withScratchProject(async (projectId) => {
    await assert.rejects(() => callPlanRoute(projectId, { asOf: "2026-01-15T00:00:00" }), (err: any) => err.statusCode === 400);
  });
});

test("AP.4 certification: topN truncates ranked only, per the pinned bounds, through the full call chain", async () => {
  await withScratchProject(async (projectId) => {
    await applyApplicationModelMerge(projectId, (store) =>
      setWorkflow(store, "a", { name: "A", riskTags: [], routeHints: ["/a"], apiHints: [] })
    );
    await applyApplicationModelMerge(projectId, (store) =>
      setWorkflow(store, "b", { name: "B", riskTags: [], routeHints: ["/b"], apiHints: [] })
    );
    const response = await callPlanRoute(projectId, { asOf: "2026-01-15T00:00:00.000Z", topN: "1" });
    assert.equal(response.ranked.length, 1);
  });
});
