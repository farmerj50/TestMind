import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { PrismaClient } from "@prisma/client";

// GET /reports/summary's "Total Tests / Pass / Fail" counts (the Dashboard hero card and each
// project card's "N failed / M passed") were computed by grouping TestRun rows by their overall
// status - but TestRunStatus.failed means "at least one test in this run failed" (worker.ts:
// `status: ok ? succeeded : failed`), so a run with 9 passing tests and 1 failing test counted
// as a single "failed" run and discarded all 9 real passes. Fixed to count TestCase rows by
// lastResultStatus (each test's own current outcome, the same canonical per-test signal
// Application Brain's qaFailures/coverage-report already use) instead.
//
// index.ts can't be booted from a test (app.listen() unconditional at module scope, no Clerk
// test-auth bypass) - this replicates the route's exact fixed query sequence directly against a
// real DB, matching the established "test through the underlying calls" precedent.

const prisma = new PrismaClient();

async function computeSummaryCounts(projectId: string, ownerId: string) {
  const counts: Record<string, number> = { queued: 0, running: 0, succeeded: 0, failed: 0, total: 0 };

  const runGrouped = await prisma.testRun.groupBy({
    by: ["status"],
    where: { projectId, project: { ownerId } },
    _count: { _all: true },
  });
  for (const g of runGrouped) {
    if (g.status === "queued" || g.status === "running") counts[g.status] = g._count._all;
  }

  const caseGrouped = await prisma.testCase.groupBy({
    by: ["lastResultStatus"],
    where: { projectId, project: { ownerId }, lastResultStatus: { not: null } },
    _count: { _all: true },
  });
  for (const g of caseGrouped) {
    counts.total += g._count._all;
    if (g.lastResultStatus === "passed") counts.succeeded += g._count._all;
    else if (g.lastResultStatus === "failed" || g.lastResultStatus === "error") counts.failed += g._count._all;
  }

  return counts;
}

test.after(() => prisma.$disconnect());

test("reports/summary counts: a run with 9 passing tests and 1 failing test reports 9 succeeded, not 0 - even though the run's own status is 'failed'", async () => {
  const user = await prisma.user.findFirst({ select: { id: true } });
  if (!user) throw new Error("No user found in DB to attach a scratch project to");
  const project = await prisma.project.create({
    data: { name: "scratch-reports-summary-counts", repoUrl: "https://example.invalid/scratch", ownerId: user.id },
  });
  try {
    // One TestRun whose overall status is "failed" because ONE of its ten tests failed - the
    // exact scenario worker.ts's `status: ok ? succeeded : failed` produces.
    const run = await prisma.testRun.create({ data: { projectId: project.id, status: "failed" } });
    const passingCases = await Promise.all(
      Array.from({ length: 9 }, (_, i) =>
        prisma.testCase.create({
          data: { projectId: project.id, key: crypto.randomUUID(), title: `passes ${i}`, lastResultStatus: "passed", lastRunId: run.id },
        })
      )
    );
    const failingCase = await prisma.testCase.create({
      data: { projectId: project.id, key: crypto.randomUUID(), title: "fails", lastResultStatus: "failed", lastRunId: run.id },
    });

    const counts = await computeSummaryCounts(project.id, user.id);

    assert.equal(counts.total, 10, "10 tests have a recorded outcome, regardless of the run's own overall status");
    assert.equal(counts.succeeded, 9, "the 9 real passes must be counted, not discarded because the run they ran in also had a failure");
    assert.equal(counts.failed, 1);
    assert.equal(counts.queued, 0);
    assert.equal(counts.running, 0);

    void passingCases;
    void failingCase;
  } finally {
    await prisma.testCase.deleteMany({ where: { projectId: project.id } });
    await prisma.testRun.deleteMany({ where: { projectId: project.id } });
    await prisma.project.delete({ where: { id: project.id } });
  }
});

test("reports/summary counts: queued/running stay run-level, and a queued/running run's tests (no lastResultStatus yet) don't inflate total", async () => {
  const user = await prisma.user.findFirst({ select: { id: true } });
  if (!user) throw new Error("No user found in DB to attach a scratch project to");
  const project = await prisma.project.create({
    data: { name: "scratch-reports-summary-counts-2", repoUrl: "https://example.invalid/scratch", ownerId: user.id },
  });
  try {
    await prisma.testRun.create({ data: { projectId: project.id, status: "queued" } });
    await prisma.testRun.create({ data: { projectId: project.id, status: "running" } });
    // A test case that's never actually produced a result yet - must not count toward total.
    await prisma.testCase.create({
      data: { projectId: project.id, key: crypto.randomUUID(), title: "never run" },
    });

    const counts = await computeSummaryCounts(project.id, user.id);

    assert.equal(counts.queued, 1);
    assert.equal(counts.running, 1);
    assert.equal(counts.total, 0, "a test case with no lastResultStatus yet must not count as an outcome");
    assert.equal(counts.succeeded, 0);
    assert.equal(counts.failed, 0);
  } finally {
    await prisma.testCase.deleteMany({ where: { projectId: project.id } });
    await prisma.testRun.deleteMany({ where: { projectId: project.id } });
    await prisma.project.delete({ where: { id: project.id } });
  }
});
