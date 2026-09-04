import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { PrismaClient } from "@prisma/client";
import { persistSecurityRegressionTest } from "../lib/security-regression-persist.js";

// QA Agent workspace (Coverage tab / Regression Protection): GET /tests/cases's select was
// extended with securityFindingId (an already-existing column, exposed - not new behavior).
// index.ts calls app.listen() at module scope, so the route can never be booted from a test
// process (established convention this whole session) - this test instead calls the exact
// Prisma query the route composes, directly, against a real DB.

const prisma = new PrismaClient();

async function selectTestCases(projectId: string) {
  return prisma.testCase.findMany({
    where: { projectId, status: { not: "archived" } },
    orderBy: [{ updatedAt: "desc" }],
    select: {
      id: true,
      key: true,
      title: true,
      status: true,
      priority: true,
      type: true,
      suiteId: true,
      curatedSuiteId: true,
      updatedAt: true,
      tags: true,
      securityFindingId: true,
    },
  });
}

test.after(() => prisma.$disconnect());

test("GET /tests/cases's select exposes securityFindingId: null for an ordinary case, populated for a VR.3B-created regression case", async () => {
  const user = await prisma.user.findFirst({ select: { id: true } });
  if (!user) throw new Error("No user found in DB to attach a scratch project to");
  const project = await prisma.project.create({
    data: { name: "scratch-qaagent-cases-select", repoUrl: "https://example.invalid/scratch", ownerId: user.id },
  });
  const scan = await prisma.securityScanJob.create({ data: { projectId: project.id, status: "completed" } });
  const finding = await prisma.securityFinding.create({
    data: {
      scanId: scan.id,
      type: "dynamic",
      severity: "medium",
      title: "IDOR on order lookup",
      status: "open",
      tool: "idor-engine",
      location: "https://example.invalid/api/orders/123",
    },
  });
  const ordinaryCase = await prisma.testCase.create({
    data: { projectId: project.id, key: "ordinary-case", title: "an ordinary test case" },
  });
  const { testCase: regressionCase, specPath } = await persistSecurityRegressionTest(finding, {
    userId: user.id,
    projectId: project.id,
  });

  try {
    const cases = await selectTestCases(project.id);
    const foundOrdinary = cases.find((c) => c.id === ordinaryCase.id);
    const foundRegression = cases.find((c) => c.id === regressionCase.id);

    assert.ok(foundOrdinary, "the ordinary case must still be returned");
    assert.equal(foundOrdinary!.securityFindingId, null, "an ordinary case has no linked finding");

    assert.ok(foundRegression, "the VR.3B-created regression case must still be returned");
    assert.equal(foundRegression!.securityFindingId, finding.id, "the regression case's securityFindingId must now be visible");
  } finally {
    await fs.rm(specPath, { force: true });
    await prisma.testCase.deleteMany({ where: { projectId: project.id } });
    await prisma.securityFinding.deleteMany({ where: { scan: { projectId: project.id } } });
    await prisma.securityScanJob.deleteMany({ where: { projectId: project.id } });
    await prisma.project.delete({ where: { id: project.id } });
  }
});
