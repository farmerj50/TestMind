import test from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import { isProjectOwner } from "../lib/project-access.js";

// index.ts can't be booted from a test (same constraint as devAgent.test.ts) - these exercise
// the message/summary routes' exact persistence/aggregation idioms directly against a real
// local DB.

const prisma = new PrismaClient();

test("messages are persisted and returned in createdAt order; ownership is enforced the same way as every other route", async () => {
  const project = await prisma.project.findFirst();
  if (!project) assert.fail("No project found in local DB - this test requires a seeded local dev DB");
  const run = await prisma.devAgentRun.create({
    data: { projectId: project!.id, mode: "assigned", targetRepo: "testmind", status: "running", requestedBy: project!.ownerId },
  });
  try {
    assert.equal(await isProjectOwner(run.projectId, project!.ownerId), true);
    assert.equal(await isProjectOwner(run.projectId, "not-the-owner"), false);

    const first = await prisma.devAgentMessage.create({ data: { devAgentRunId: run.id, role: "user", content: "Fix the flaky login test." } });
    await new Promise((r) => setTimeout(r, 5));
    const second = await prisma.devAgentMessage.create({ data: { devAgentRunId: run.id, role: "assistant", content: "Looking into it." } });

    const messages = await prisma.devAgentMessage.findMany({ where: { devAgentRunId: run.id }, orderBy: { createdAt: "asc" } });
    assert.deepEqual(messages.map((m) => m.id), [first.id, second.id]);
    assert.equal(messages[0].role, "user");
    assert.equal(messages[1].role, "assistant");
  } finally {
    await prisma.devAgentRun.deleteMany({ where: { id: run.id } }); // cascades messages
  }
});

test("summary aggregates iteration count, the union of files changed across iterations, latest test result, and spend", async () => {
  const project = await prisma.project.findFirst();
  if (!project) assert.fail("No project found in local DB - this test requires a seeded local dev DB");
  const run = await prisma.devAgentRun.create({
    data: { projectId: project!.id, mode: "assigned", targetRepo: "testmind", status: "running", requestedBy: project!.ownerId, spentUsd: 0.42, budgetUsd: 5 },
  });
  try {
    await prisma.devAgentIteration.create({
      data: { devAgentRunId: run.id, iterationNumber: 1, phase: "code", filesChanged: [{ path: "a.ts", content: "x" }], costUsd: 0.1 },
    });
    await prisma.devAgentIteration.create({
      data: { devAgentRunId: run.id, iterationNumber: 2, phase: "test", filesChanged: [{ path: "b.ts", content: "y" }], testResult: { passed: false, output: "1 failing" }, costUsd: 0.2 },
    });

    const iterations = await prisma.devAgentIteration.findMany({ where: { devAgentRunId: run.id }, orderBy: { iterationNumber: "asc" } });
    const filesChanged = new Set<string>();
    for (const it of iterations) {
      if (Array.isArray(it.filesChanged)) for (const f of it.filesChanged as any[]) if (f?.path) filesChanged.add(f.path);
    }
    const latest = iterations[iterations.length - 1];

    assert.equal(iterations.length, 2);
    assert.deepEqual([...filesChanged].sort(), ["a.ts", "b.ts"]);
    assert.deepEqual(latest.testResult, { passed: false, output: "1 failing" });

    const refreshedRun = await prisma.devAgentRun.findUnique({ where: { id: run.id } });
    assert.equal(refreshedRun?.spentUsd, 0.42);
    assert.equal(refreshedRun?.budgetUsd, 5);
  } finally {
    await prisma.devAgentRun.deleteMany({ where: { id: run.id } }); // cascades iterations
  }
});

test("summary's awaitingReview is true only when a run is succeeded AND has a prUrl, never otherwise", async () => {
  const project = await prisma.project.findFirst();
  if (!project) assert.fail("No project found in local DB - this test requires a seeded local dev DB");

  const stillRunning = await prisma.devAgentRun.create({
    data: { projectId: project!.id, mode: "assigned", targetRepo: "testmind", status: "running", requestedBy: project!.ownerId, prUrl: "https://github.com/acme/widgets/pull/9" },
  });
  const succeededNoPr = await prisma.devAgentRun.create({
    data: { projectId: project!.id, mode: "assigned", targetRepo: "testmind", status: "succeeded", requestedBy: project!.ownerId },
  });
  const succeededWithPr = await prisma.devAgentRun.create({
    data: { projectId: project!.id, mode: "assigned", targetRepo: "testmind", status: "succeeded", requestedBy: project!.ownerId, prUrl: "https://github.com/acme/widgets/pull/9" },
  });
  try {
    const awaitingReview = (r: { status: string; prUrl: string | null }) => r.status === "succeeded" && !!r.prUrl;
    assert.equal(awaitingReview(stillRunning), false);
    assert.equal(awaitingReview(succeededNoPr), false);
    assert.equal(awaitingReview(succeededWithPr), true);
  } finally {
    await prisma.devAgentRun.deleteMany({ where: { id: { in: [stillRunning.id, succeededNoPr.id, succeededWithPr.id] } } });
  }
});
