import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { investigateTestResult } from "./investigator-query.js";

// Ticket INV.2 - integration test for the project-scoped TestResult lookup. index.ts's route
// can never be booted/imported from a test (app.listen() runs unconditionally at module scope,
// no Clerk test-auth bypass) - tested through investigateTestResult, the exact function the
// route calls, matching AB.5/AP.4's established "test through the underlying functions"
// precedent for this codebase.

const prisma = new PrismaClient();

async function withScratchProject(run: (projectId: string) => Promise<void>) {
  const user = await prisma.user.findFirst({ select: { id: true } });
  if (!user) throw new Error("No user found in DB to attach a scratch project to");
  const project = await prisma.project.create({
    data: { name: "scratch-inv2-query", repoUrl: "https://example.invalid/scratch", ownerId: user.id },
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

test("investigateTestResult returns the expected shape for a classifiable TestResult", async () => {
  await withScratchProject(async (projectId) => {
    const testResult = await seedTestResult(projectId, "LOCATOR_RESOLUTION_FAILED: could not resolve #submit");
    const result = await investigateTestResult(projectId, testResult.id);
    assert.ok(result);
    assert.equal(result!.testResultId, testResult.id);
    assert.equal(result!.verdict, "AUTOMATION_DRIFT");
    assert.equal(result!.evidenceAvailable, true);
    assert.ok(result!.matchedSignals.some((s) => s.source === "repairFailureClass" && s.value === "locator_resolution_failed"));
  });
});

test("investigateTestResult returns the expected shape for a null-message TestResult", async () => {
  await withScratchProject(async (projectId) => {
    const testResult = await seedTestResult(projectId, null);
    const result = await investigateTestResult(projectId, testResult.id);
    assert.ok(result);
    assert.equal(result!.verdict, "UNKNOWN");
    assert.equal(result!.evidenceAvailable, false);
    assert.deepEqual(result!.matchedSignals, []);
  });
});

test("investigateTestResult returns null (404-equivalent) for a testResultId that belongs to a different project", async () => {
  await withScratchProject(async (projectA) => {
    const testResult = await seedTestResult(projectA, "some failure");
    await withScratchProject(async (projectB) => {
      const result = await investigateTestResult(projectB, testResult.id);
      assert.equal(result, null);
    });
  });
});

test("investigateTestResult returns null for a testResultId that doesn't exist at all", async () => {
  await withScratchProject(async (projectId) => {
    const result = await investigateTestResult(projectId, "does-not-exist");
    assert.equal(result, null);
  });
});

// Ticket INV.3 - healing-history enrichment. A TestCase with no TestHealingAttempt rows at
// all must report "no-history" (already implicitly covered by the two tests above, which
// never seed one) - these tests cover every other pinned mapping and the mixed-history
// recency rule.

async function seedHealingAttempt(runId: string, testResultId: string, testCaseId: string, status: string, createdAt: Date, attempt = 1) {
  return prisma.testHealingAttempt.create({
    data: { runId, testResultId, testCaseId, status: status as any, createdAt, attempt },
  });
}

test("healingHistory: no TestHealingAttempt rows -> no-history", async () => {
  await withScratchProject(async (projectId) => {
    const testResult = await seedTestResult(projectId, "some failure");
    const result = await investigateTestResult(projectId, testResult.id);
    assert.equal(result!.healingHistory, "no-history");
  });
});

test("healingHistory: latest attempt succeeded -> prior-heal-succeeded", async () => {
  await withScratchProject(async (projectId) => {
    const testResult = await seedTestResult(projectId, "some failure");
    await seedHealingAttempt(testResult.runId, testResult.id, testResult.testCaseId, "succeeded", new Date("2026-01-01T00:00:00.000Z"));
    const result = await investigateTestResult(projectId, testResult.id);
    assert.equal(result!.healingHistory, "prior-heal-succeeded");
  });
});

test("healingHistory: latest attempt failed -> prior-heal-not-succeeded", async () => {
  await withScratchProject(async (projectId) => {
    const testResult = await seedTestResult(projectId, "some failure");
    await seedHealingAttempt(testResult.runId, testResult.id, testResult.testCaseId, "failed", new Date("2026-01-01T00:00:00.000Z"));
    const result = await investigateTestResult(projectId, testResult.id);
    assert.equal(result!.healingHistory, "prior-heal-not-succeeded");
  });
});

test("healingHistory: latest attempt needs_review -> prior-heal-not-succeeded", async () => {
  await withScratchProject(async (projectId) => {
    const testResult = await seedTestResult(projectId, "some failure");
    await seedHealingAttempt(testResult.runId, testResult.id, testResult.testCaseId, "needs_review", new Date("2026-01-01T00:00:00.000Z"));
    const result = await investigateTestResult(projectId, testResult.id);
    assert.equal(result!.healingHistory, "prior-heal-not-succeeded");
  });
});

test("healingHistory: an older succeeded attempt followed by a newer failed one -> prior-heal-not-succeeded (recency wins, not 'ever succeeded')", async () => {
  await withScratchProject(async (projectId) => {
    const testResult = await seedTestResult(projectId, "some failure");
    await seedHealingAttempt(testResult.runId, testResult.id, testResult.testCaseId, "succeeded", new Date("2026-01-01T00:00:00.000Z"), 1);
    await seedHealingAttempt(testResult.runId, testResult.id, testResult.testCaseId, "failed", new Date("2026-01-05T00:00:00.000Z"), 2);
    const result = await investigateTestResult(projectId, testResult.id);
    assert.equal(result!.healingHistory, "prior-heal-not-succeeded");
  });
});

test("healingHistory is a separate top-level field, never merged into matchedSignals", async () => {
  await withScratchProject(async (projectId) => {
    const testResult = await seedTestResult(projectId, "LOCATOR_RESOLUTION_FAILED: could not resolve #submit");
    await seedHealingAttempt(testResult.runId, testResult.id, testResult.testCaseId, "succeeded", new Date("2026-01-01T00:00:00.000Z"));
    const result = await investigateTestResult(projectId, testResult.id);
    assert.equal(result!.healingHistory, "prior-heal-succeeded");
    assert.ok(result!.matchedSignals.length > 0, "sanity: this message does produce matchedSignals");
    for (const signal of result!.matchedSignals) {
      assert.ok(!("healingHistory" in signal), "matchedSignals entries must never carry a healingHistory field");
    }
  });
});
