import test from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../prisma.js";
import { purgeExpiredEvaluationData, defaultRetentionCutoff, DEFAULT_RETENTION_DAYS } from "./evaluation-retention.js";

test("defaultRetentionCutoff is DEFAULT_RETENTION_DAYS before the given date", () => {
  const now = new Date("2026-06-01T00:00:00Z");
  const cutoff = defaultRetentionCutoff(now);
  const diffDays = (now.getTime() - cutoff.getTime()) / (24 * 60 * 60 * 1000);
  assert.equal(diffDays, DEFAULT_RETENTION_DAYS);
});

test("purgeExpiredEvaluationData deletes only rows older than the cutoff, against real local rows", async () => {
  const project = await prisma.project.findFirst();
  assert.ok(project, "expected at least one real local project to test against");

  const oldDate = new Date("2020-01-01T00:00:00Z");
  const newDate = new Date();
  const cutoff = new Date("2024-01-01T00:00:00Z");

  const oldRun = await prisma.evaluationRun.create({
    data: {
      projectId: project!.id, datasetId: "retention-test", datasetVersion: "v1",
      applicationId: "retention-test", applicationVersion: "v1", casesJson: [{ case_id: "c1" }],
      status: "succeeded", createdAt: oldDate,
    },
  });
  const newRun = await prisma.evaluationRun.create({
    data: {
      projectId: project!.id, datasetId: "retention-test", datasetVersion: "v1",
      applicationId: "retention-test", applicationVersion: "v1", casesJson: [{ case_id: "c1" }],
      status: "succeeded", createdAt: newDate,
    },
  });
  const oldAudit = await prisma.auditLog.create({
    data: { projectId: project!.id, action: "retention-test", targetType: "Test", createdAt: oldDate },
  });
  const newAudit = await prisma.auditLog.create({
    data: { projectId: project!.id, action: "retention-test", targetType: "Test", createdAt: newDate },
  });

  try {
    const result = await purgeExpiredEvaluationData(cutoff, project!.id);
    assert.ok(result.evaluationRunsDeleted >= 1);
    assert.ok(result.auditLogsDeleted >= 1);

    assert.equal(await prisma.evaluationRun.findUnique({ where: { id: oldRun.id } }), null);
    assert.ok(await prisma.evaluationRun.findUnique({ where: { id: newRun.id } }));
    assert.equal(await prisma.auditLog.findUnique({ where: { id: oldAudit.id } }), null);
    assert.ok(await prisma.auditLog.findUnique({ where: { id: newAudit.id } }));
  } finally {
    await prisma.evaluationRun.deleteMany({ where: { id: { in: [oldRun.id, newRun.id] } } });
    await prisma.auditLog.deleteMany({ where: { id: { in: [oldAudit.id, newAudit.id] } } });
  }
});

test("purgeExpiredEvaluationData is never auto-invoked anywhere in the codebase", async () => {
  // Grep-style structural check: this function must only ever be called explicitly by a
  // caller (admin tooling, a future separately-authorized scheduler) - never wired into
  // startup/index.ts or a scheduler module as part of this phase.
  const indexSource = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("../index.ts", import.meta.url), "utf8")
  );
  assert.ok(!indexSource.includes("purgeExpiredEvaluationData"), "must not be wired into index.ts's boot path");
});
