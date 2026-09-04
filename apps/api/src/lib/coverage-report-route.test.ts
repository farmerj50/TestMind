import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { getApplicationBrainSnapshot } from "./application-brain-query.js";
import { getWorkflowCoverageReport } from "./coverage-report.js";
import { applyApplicationModelMerge } from "./application-model-store.js";
import { computeApplicationModelUpdate, setWorkflow, upsertTestLink } from "./application-model.js";

// Ticket CS.2 - DB-backed test for GET /projects/:id/coverage, exercised through the exact
// call sequence the route runs (getApplicationBrainSnapshot -> getWorkflowCoverageReport).
// index.ts still can't be booted from a test (app.listen() unconditional at module scope, no
// Clerk test-auth bypass) - matches AP.3/INV.2/VR.2's established "test through the underlying
// functions" precedent.

const prisma = new PrismaClient();

async function withScratchProject(run: (projectId: string) => Promise<void>) {
  const user = await prisma.user.findFirst({ select: { id: true } });
  if (!user) throw new Error("No user found in DB to attach a scratch project to");
  const project = await prisma.project.create({
    data: { name: "scratch-cs2-coverage-route", repoUrl: "https://example.invalid/scratch", ownerId: user.id },
  });
  try {
    await run(project.id);
  } finally {
    await prisma.testCase.deleteMany({ where: { projectId: project.id } });
    await prisma.securityFinding.deleteMany({ where: { scan: { projectId: project.id } } });
    await prisma.securityScanJob.deleteMany({ where: { projectId: project.id } });
    await prisma.project.delete({ where: { id: project.id } });
  }
}

test.after(() => prisma.$disconnect());

test("GET /projects/:id/coverage's underlying call sequence returns the expected shape against a real seeded project", async () => {
  await withScratchProject(async (projectId) => {
    await applyApplicationModelMerge(projectId, (store) =>
      computeApplicationModelUpdate(store, { "/checkout": [{ selector: "#pay", fields: [{ name: "cardNumber" }] }] }, "2026-01-01T00:00:00.000Z").next
    );
    await applyApplicationModelMerge(projectId, (store) =>
      setWorkflow(store, "checkout", { name: "Checkout", riskTags: ["critical"], routeHints: ["/checkout"], apiHints: [] })
    );
    const testCase = await prisma.testCase.create({
      data: { projectId, key: crypto.randomUUID(), title: "checkout fails", lastResultStatus: "failed" },
    });
    await applyApplicationModelMerge(projectId, (store) => upsertTestLink(store, testCase.id, "/checkout", "2026-01-01T00:00:00.000Z"));

    const scan = await prisma.securityScanJob.create({ data: { projectId, status: "completed" } });
    await prisma.securityFinding.create({
      data: { scanId: scan.id, type: "dynamic", severity: "high", title: "IDOR", tool: "idor-engine", location: "https://example.invalid/checkout", validationStatus: null },
    });

    // The route's exact call sequence.
    const snapshot = await getApplicationBrainSnapshot(projectId);
    const report = getWorkflowCoverageReport(snapshot);

    assert.equal(report.workflows.length, 1);
    const checkout = report.workflows[0];
    assert.equal(checkout.key, "checkout");
    assert.equal(checkout.qaFailuresCount, 1);
    assert.equal(checkout.securityFindingsByValidationStatus.untriaged, 1);
    assert.equal(report.openItems.untriagedFindingsCount, 1);
    assert.equal(report.openItems.unresolvedQaFailuresCount, 1);
    assert.deepEqual(report.notAttributableFindings, []);
  });
});
