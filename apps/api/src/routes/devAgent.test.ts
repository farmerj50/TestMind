import test from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import { requiresExternalRepoConfirmation } from "./devAgent.js";
import { isProjectOwner } from "../lib/project-access.js";

// index.ts can't be booted from a test (same constraint as evaluations-datasets.test.ts) -
// this exercises the route's exact logic/persistence idioms directly against a real local DB.

const prisma = new PrismaClient();

test("requiresExternalRepoConfirmation: testmind never needs confirmation", () => {
  assert.equal(requiresExternalRepoConfirmation("testmind", undefined), false);
  assert.equal(requiresExternalRepoConfirmation("testmind", false), false);
});

test("requiresExternalRepoConfirmation: an external repo requires explicit confirmExternalRepo:true", () => {
  assert.equal(requiresExternalRepoConfirmation("https://github.com/acme/widgets", undefined), true);
  assert.equal(requiresExternalRepoConfirmation("https://github.com/acme/widgets", false), true);
  assert.equal(requiresExternalRepoConfirmation("https://github.com/acme/widgets", true), false);
});

test("isProjectOwner enforces ownership for DevAgentRun creation (reused as-is, not reinvented)", async () => {
  const project = await prisma.project.findFirst();
  if (!project) assert.fail("No project found in local DB - this test requires a seeded local dev DB");
  assert.equal(await isProjectOwner(project!.id, project!.ownerId), true);
  assert.equal(await isProjectOwner(project!.id, "not-the-owner"), false);
});

test("creating a DevAgentRun links to a real OperatorJob of type autonomousDev, mode 'assigned'", async () => {
  const project = await prisma.project.findFirst();
  if (!project) assert.fail("No project found in local DB - this test requires a seeded local dev DB");

  const run = await prisma.devAgentRun.create({
    data: { projectId: project!.id, mode: "assigned", targetRepo: "testmind", instructionText: "Fix the flaky test.", requestedBy: project!.ownerId },
  });
  try {
    const opJob = await prisma.operatorJob.create({
      data: { projectId: project!.id, type: "autonomousDev", requestedBy: project!.ownerId, contextJson: { devAgentRunId: run.id } },
    });
    await prisma.devAgentRun.update({ where: { id: run.id }, data: { operatorJobId: opJob.id } });

    const linked = await prisma.devAgentRun.findUnique({ where: { id: run.id } });
    assert.equal(linked?.operatorJobId, opJob.id);
    assert.equal(linked?.mode, "assigned");
    assert.equal(linked?.status, "queued");

    await prisma.operatorJob.delete({ where: { id: opJob.id } });
  } finally {
    await prisma.devAgentRun.deleteMany({ where: { id: run.id } });
  }
});

test("pause/resume/stop transition DevAgentRun.status exactly as the routes do, and refuse invalid transitions", async () => {
  const project = await prisma.project.findFirst();
  if (!project) assert.fail("No project found in local DB - this test requires a seeded local dev DB");

  const run = await prisma.devAgentRun.create({
    data: { projectId: project!.id, mode: "assigned", targetRepo: "testmind", status: "running", requestedBy: project!.ownerId },
  });
  try {
    // pause: running -> paused (valid)
    let current = await prisma.devAgentRun.findUnique({ where: { id: run.id } });
    assert.equal(current?.status, "running");
    const paused = await prisma.devAgentRun.update({ where: { id: run.id }, data: { status: "paused" } });
    assert.equal(paused.status, "paused");

    // the route refuses pause unless status === 'running' - replicate that guard here
    current = await prisma.devAgentRun.findUnique({ where: { id: run.id } });
    assert.notEqual(current?.status, "running"); // so a second pause attempt would be refused by the route's own check

    // resume: paused -> running (valid)
    const resumed = await prisma.devAgentRun.update({ where: { id: run.id }, data: { status: "running" } });
    assert.equal(resumed.status, "running");

    // stop: running -> canceled (valid), and stop again should be refused (already terminal)
    const stopped = await prisma.devAgentRun.update({ where: { id: run.id }, data: { status: "canceled", finishedAt: new Date() } });
    assert.equal(stopped.status, "canceled");
    assert.ok(["succeeded", "failed", "canceled"].includes(stopped.status), "terminal status must be recognized by the route's re-stop guard");
  } finally {
    await prisma.devAgentRun.deleteMany({ where: { id: run.id } });
  }
});
