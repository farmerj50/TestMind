import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { investigateFailure, type InvestigatorVerdict } from "./investigator.js";
import { investigateTestResult } from "./investigator-query.js";

// Ticket INV.4 - certification. Per the frozen contract, "no new product code unless a test
// exposes a bug." index.ts's GET /projects/:id/investigator/:testResultId can never be
// imported/booted from a test (app.listen() unconditional at module scope, no Clerk test-auth
// bypass) - certified by calling investigateTestResult, the exact function the route calls,
// matching AB.5/AP.4's established precedent.

// ── Real failure-message corpus, pulled verbatim from ai/core/repair-policy.test.ts's
// existing fixtures (not invented for this ticket) - every `message` string that file's own
// tests already exercise classifyFailureContext with. See that file for provenance/context on
// each (several are regression fixtures for real, previously-captured self-heal failures).
const REAL_MESSAGE_CORPUS: string[] = [
  "Error: expect(locator).toBeVisible() failed\n\n" +
    "Locator: getByText('JusticePath — Accessible Legal Help')\n" +
    "Expected: visible\nTimeout: 10000ms\nError: element(s) not found",
  "Locator: getByText('JusticePath — Accessible Legal Help')\nError: element(s) not found",
  "Test timeout of 30000ms exceeded.",
  'Expect "toBeVisible" with timeout 10000ms waiting for getByText(/success/i)',
  "some timeout",
  "Error: usernameSelector not found",
  "some failure",
];

const BEHAVIORALLY_UNREACHABLE_IN_V1: InvestigatorVerdict[] = [
  "PRODUCT_DEFECT",
  "DATA_FAILURE",
  "DEPENDENCY_FAILURE",
  "SECURITY_ANOMALY",
  "EXPECTED_CHANGE",
];

test("INV.4 certification: none of the 5 behaviorally-unreachable verdicts are ever produced across the real repair-policy.test.ts message corpus", () => {
  for (const message of REAL_MESSAGE_CORPUS) {
    const result = investigateFailure({ message });
    assert.ok(
      !BEHAVIORALLY_UNREACHABLE_IN_V1.includes(result.verdict),
      `message ${JSON.stringify(message)} produced ${result.verdict}, which must be unreachable in v1`
    );
  }
});

const prisma = new PrismaClient();

async function withScratchProject(run: (projectId: string) => Promise<void>) {
  const user = await prisma.user.findFirst({ select: { id: true } });
  if (!user) throw new Error("No user found in DB to attach a scratch project to");
  const project = await prisma.project.create({
    data: { name: "scratch-inv4-certification", repoUrl: "https://example.invalid/scratch", ownerId: user.id },
  });
  try {
    await run(project.id);
  } finally {
    await prisma.testHealingAttempt.deleteMany({ where: { run: { projectId: project.id } } });
    await prisma.testResult.deleteMany({ where: { run: { projectId: project.id } } });
    await prisma.testRun.deleteMany({ where: { projectId: project.id } });
    await prisma.testCase.deleteMany({ where: { projectId: project.id } });
    await prisma.project.delete({ where: { id: project.id } });
  }
}

async function seedTestResult(projectId: string, message: string | null) {
  const testCase = await prisma.testCase.create({ data: { projectId, key: crypto.randomUUID(), title: "a test" } });
  const run = await prisma.testRun.create({ data: { projectId } });
  return prisma.testResult.create({ data: { runId: run.id, testCaseId: testCase.id, status: "failed", message } });
}

test.after(() => prisma.$disconnect());

test("INV.4 certification: one real, seeded, end-to-end case per verdict path, through investigateTestResult", async () => {
  await withScratchProject(async (projectId) => {
    // AUTOMATION_DRIFT
    const drift = await seedTestResult(projectId, "LOCATOR_RESOLUTION_FAILED: could not resolve #submit");
    const driftResult = await investigateTestResult(projectId, drift.id);
    assert.equal(driftResult!.verdict, "AUTOMATION_DRIFT");
    assert.equal(driftResult!.evidenceAvailable, true);
    assert.equal(driftResult!.healingHistory, "no-history");

    // ENVIRONMENT_FAILURE
    const env = await seedTestResult(projectId, "net::ERR_CONNECTION_REFUSED at https://example.invalid");
    const envResult = await investigateTestResult(projectId, env.id);
    assert.equal(envResult!.verdict, "ENVIRONMENT_FAILURE");
    assert.equal(envResult!.evidenceAvailable, true);

    // UNKNOWN with evidence (a real message that matches nothing)
    const unknownWithEvidence = await seedTestResult(projectId, "The widget rendered an unexpected shade of blue.");
    const unknownWithEvidenceResult = await investigateTestResult(projectId, unknownWithEvidence.id);
    assert.equal(unknownWithEvidenceResult!.verdict, "UNKNOWN");
    assert.equal(unknownWithEvidenceResult!.evidenceAvailable, true);
    assert.deepEqual(unknownWithEvidenceResult!.matchedSignals, []);

    // UNKNOWN without evidence (null message)
    const unknownNoEvidence = await seedTestResult(projectId, null);
    const unknownNoEvidenceResult = await investigateTestResult(projectId, unknownNoEvidence.id);
    assert.equal(unknownNoEvidenceResult!.verdict, "UNKNOWN");
    assert.equal(unknownNoEvidenceResult!.evidenceAvailable, false);
    assert.deepEqual(unknownNoEvidenceResult!.matchedSignals, []);
  });
});
