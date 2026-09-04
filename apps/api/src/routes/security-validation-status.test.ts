import test from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";

// Ticket VR.1 - integration test for SecurityFinding.validationStatus. index.ts (which
// registers routes/security.ts as a plugin) can never be booted/imported from a test
// (app.listen() unconditional at module scope, no Clerk test-auth bypass) - so this exercises
// the exact same query pattern the PATCH /security/findings/:id/validation-status route uses
// directly against a real DB: the ownership-scoped findFirst (the route's actual security
// boundary) followed by the update, matching the established "test through the underlying
// logic" precedent used throughout AB.1-INV.4.

const prisma = new PrismaClient();

const ALL_VALIDATION_STATUSES = [
  "confirmed",
  "likely",
  "suspected",
  "inconclusive",
  "not_exploitable",
  "false_positive",
  "not_applicable",
] as const;

async function withScratchFinding(run: (ctx: { projectId: string; ownerId: string; findingId: string }) => Promise<void>) {
  const user = await prisma.user.findFirst({ select: { id: true } });
  if (!user) throw new Error("No user found in DB to attach a scratch project to");
  const project = await prisma.project.create({
    data: { name: "scratch-vr1-validation-status", repoUrl: "https://example.invalid/scratch", ownerId: user.id },
  });
  const scan = await prisma.securityScanJob.create({ data: { projectId: project.id, status: "completed" } });
  // Real scanner modules always write status: "open" explicitly (it has no schema default) -
  // matching that here so the "status untouched" assertions below are meaningful.
  const finding = await prisma.securityFinding.create({
    data: { scanId: scan.id, type: "dynamic", severity: "medium", title: "a finding", tool: "idor-engine", status: "open" },
  });
  try {
    await run({ projectId: project.id, ownerId: user.id, findingId: finding.id });
  } finally {
    await prisma.securityFinding.deleteMany({ where: { scan: { projectId: project.id } } });
    await prisma.securityScanJob.deleteMany({ where: { projectId: project.id } });
    await prisma.project.delete({ where: { id: project.id } });
  }
}

test.after(() => prisma.$disconnect());

test("a freshly-created SecurityFinding defaults validationStatus to null (untriaged), status to 'open'", async () => {
  await withScratchFinding(async ({ findingId }) => {
    const finding = await prisma.securityFinding.findUniqueOrThrow({ where: { id: findingId } });
    assert.equal(finding.validationStatus, null);
    assert.equal(finding.status, "open");
  });
});

test("validationStatus can be set to each of the 7 vocabulary values, and the legacy status column is never touched", async () => {
  await withScratchFinding(async ({ findingId }) => {
    for (const value of ALL_VALIDATION_STATUSES) {
      const updated = await prisma.securityFinding.update({
        where: { id: findingId },
        data: { validationStatus: value },
      });
      assert.equal(updated.validationStatus, value);
      assert.equal(updated.status, "open", "the legacy status column must never change");
    }
  });
});

test("the route's ownership-scoped lookup (scan.project.ownerId) finds the finding for its real owner", async () => {
  await withScratchFinding(async ({ findingId, ownerId }) => {
    const finding = await prisma.securityFinding.findFirst({
      where: { id: findingId, scan: { project: { ownerId } } },
    });
    assert.ok(finding, "the real owner must be able to look up their own finding");
  });
});

test("the route's ownership-scoped lookup returns null for a non-owner, matching the route's 404 behavior", async () => {
  await withScratchFinding(async ({ findingId }) => {
    const finding = await prisma.securityFinding.findFirst({
      where: { id: findingId, scan: { project: { ownerId: "not-the-real-owner" } } },
    });
    assert.equal(finding, null, "a non-owner's scoped lookup must find nothing, which is what makes the route 404");
  });
});
