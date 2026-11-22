import test from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../prisma.js";
import { recordAuditLog } from "./audit-log.js";

test("recordAuditLog persists a real row with the given fields", async () => {
  const project = await prisma.project.findFirst();
  assert.ok(project, "expected at least one real local project to test against");

  await recordAuditLog({
    projectId: project!.id,
    actorId: "user-test",
    action: "test.action",
    targetType: "Test",
    targetId: "target-1",
    metadataJson: { foo: "bar" },
  });

  const row = await prisma.auditLog.findFirst({
    where: { projectId: project!.id, action: "test.action", targetId: "target-1" },
    orderBy: { createdAt: "desc" },
  });
  assert.ok(row);
  assert.equal(row!.actorId, "user-test");
  assert.deepEqual(row!.metadataJson, { foo: "bar" });

  await prisma.auditLog.delete({ where: { id: row!.id } });
});
