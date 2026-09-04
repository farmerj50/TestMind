import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import { getApplicationBrainSnapshot } from "./application-brain-query.js";
import { getWorkflowCoverageReport } from "./coverage-report.js";
import { applyApplicationModelMerge } from "./application-model-store.js";
import { computeApplicationModelUpdate, setWorkflow, upsertTestLink } from "./application-model.js";
import { persistSecurityRegressionTest } from "./security-regression-persist.js";

// Ticket CS.3 - certification, closing Coverage + Stop Decision v1 AND, with it, the entire
// 6-item TestMind Autonomous v1 program. Exercises: CS.0's fix (eligible + ineligible findings
// through persistSecurityRegressionTest), CS.1's aggregation against a realistically-seeded
// project, determinism (two calls, byte-identical output), and the zero-autonomous-planner.ts-
// coupling assertion - re-verified here at the closing gate, not just at CS.1's unit-test level.

const prisma = new PrismaClient();

async function withScratchProject(run: (ctx: { projectId: string; userId: string }) => Promise<void>) {
  const user = await prisma.user.findFirst({ select: { id: true } });
  if (!user) throw new Error("No user found in DB to attach a scratch project to");
  const project = await prisma.project.create({
    data: { name: "scratch-cs3-certification", repoUrl: "https://example.invalid/scratch", ownerId: user.id },
  });
  try {
    await run({ projectId: project.id, userId: user.id });
  } finally {
    await prisma.testCase.deleteMany({ where: { projectId: project.id } });
    await prisma.securityFinding.deleteMany({ where: { scan: { projectId: project.id } } });
    await prisma.securityScanJob.deleteMany({ where: { projectId: project.id } });
    await prisma.project.delete({ where: { id: project.id } });
  }
}

test.after(() => prisma.$disconnect());

test("CS.3 certification: the full slice end-to-end - CS.0's fix, CS.1's aggregation, determinism - against a realistically-seeded project", async () => {
  await withScratchProject(async ({ projectId, userId }) => {
    // ── Application Brain: a "/checkout" page + workflow, and one real failing QA case.
    await applyApplicationModelMerge(projectId, (store) =>
      computeApplicationModelUpdate(store, { "/checkout": [{ selector: "#pay", fields: [{ name: "cardNumber" }] }] }, "2026-01-01T00:00:00.000Z").next
    );
    await applyApplicationModelMerge(projectId, (store) =>
      setWorkflow(store, "checkout", { name: "Checkout", riskTags: ["critical"], routeHints: ["/checkout"], apiHints: [] })
    );
    const qaCase = await prisma.testCase.create({
      data: { projectId, key: crypto.randomUUID(), title: "checkout payment fails", lastResultStatus: "failed" },
    });
    await applyApplicationModelMerge(projectId, (store) => upsertTestLink(store, qaCase.id, "/checkout", "2026-01-01T00:00:00.000Z"));

    // ── An eligible (URL-shaped-tool) finding and an ineligible one, each turned into a
    // persisted regression test via CS.0's fixed persistSecurityRegressionTest.
    const scan = await prisma.securityScanJob.create({ data: { projectId, status: "completed" } });
    const eligibleFinding = await prisma.securityFinding.create({
      data: {
        scanId: scan.id, type: "dynamic", severity: "high", title: "IDOR on checkout",
        status: "open", tool: "idor-engine", location: "https://example.invalid/checkout",
      },
    });
    const ineligibleFinding = await prisma.securityFinding.create({
      data: {
        scanId: scan.id, type: "static_analysis", severity: "medium", title: "hardcoded secret",
        status: "open", tool: "code-review", location: "apps/api/src/index.ts:99",
      },
    });
    const eligibleRegression = await persistSecurityRegressionTest(eligibleFinding, { userId, projectId });
    const ineligibleRegression = await persistSecurityRegressionTest(ineligibleFinding, { userId, projectId });
    try {
      // ── CS.0's fix, verified end-to-end: eligible regression TestCase is linked; ineligible
      // one carries no fabricated route.
      const eligiblePreconditions = JSON.parse(eligibleRegression.testCase.preconditions!);
      assert.equal(eligiblePreconditions.route, "/checkout");
      const ineligiblePreconditions = JSON.parse(ineligibleRegression.testCase.preconditions!);
      assert.ok(!("route" in ineligiblePreconditions));

      // ── A human triages the eligible finding to confirmed (VR.1).
      await prisma.securityFinding.update({ where: { id: eligibleFinding.id }, data: { validationStatus: "confirmed" } });

      // ── The route's exact call sequence (CS.2), called twice to prove determinism.
      const snapshot1 = await getApplicationBrainSnapshot(projectId);
      const report1 = getWorkflowCoverageReport(snapshot1);
      const snapshot2 = await getApplicationBrainSnapshot(projectId);
      const report2 = getWorkflowCoverageReport(snapshot2);
      assert.deepEqual(report1, report2, "calling the report twice against unchanged stored data must return byte-identical output");

      // ── CS.1's aggregation, verified against real, non-trivial data.
      assert.equal(report1.workflows.length, 1);
      const checkout = report1.workflows[0];
      assert.equal(checkout.coveragePercent, 100, "the workflow's one declared routeHint is linked (by both the QA case and the eligible regression test)");
      assert.equal(checkout.coverageGapPercent, 0);
      assert.equal(checkout.qaFailuresCount, 1, "only the real failing QA case counts - the regression TestCase itself has no lastResultStatus and must not be double-counted as a failure");
      assert.equal(checkout.securityFindingsByValidationStatus.confirmed, 1);
      assert.equal(checkout.securityFindingsByValidationStatus.untriaged, 0);

      assert.equal(report1.notAttributableFindings.length, 1, "the ineligible finding is correctly excluded from any workflow, never corrupted with a fabricated route");
      assert.equal(report1.notAttributableFindings[0].id, ineligibleFinding.id);

      assert.equal(report1.openItems.untriagedFindingsCount, 1, "only the still-untriaged notAttributable finding");
      assert.equal(report1.openItems.unresolvedQaFailuresCount, 1);

      // ── Absence proof: no synthesized recommendation/verdict/saturation anywhere in the
      // output, matching INV.4/VR.4's "prove through actual output, not just trust the
      // contract" discipline.
      const serialized = JSON.stringify(report1).toLowerCase();
      for (const forbidden of ["saturation", "recommend", "residualrisk", "residual_risk", "verdict"]) {
        assert.ok(!serialized.includes(forbidden), `the closing certification's own output must never contain a "${forbidden}"-shaped field`);
      }

      // ── Re-verified at the closing gate (not just CS.1's unit test): zero import-level
      // coupling to autonomous-planner.ts anywhere in this item's code.
      const here = path.dirname(fileURLToPath(import.meta.url));
      for (const file of ["coverage-report.ts", "security-regression-persist.ts"]) {
        const source = fs.readFileSync(path.join(here, file), "utf8");
        const importLines = source.split("\n").filter((line) => /^\s*import\b/.test(line));
        assert.ok(
          importLines.every((line) => !line.includes("autonomous-planner")),
          `${file} must have no import statement referencing autonomous-planner.ts`
        );
      }
    } finally {
      await fs.promises.rm(eligibleRegression.specPath, { force: true });
      await fs.promises.rm(ineligibleRegression.specPath, { force: true });
    }
  });
});
