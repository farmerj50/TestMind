import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { PrismaClient } from "@prisma/client";
import { collectFileChanges, publishDevAgentPullRequest, DevAgentPrError } from "./dev-agent-pr.js";

const prisma = new PrismaClient();

test("collectFileChanges merges per-iteration file lists, later iterations winning on path collision", () => {
  const result = collectFileChanges([
    [{ path: "a.ts", content: "v1" }, { path: "b.ts", content: "v1" }],
    [{ path: "a.ts", content: "v2" }],
    null, // an iteration recorded before real diff-application landed has no array shape - skipped, not thrown
    [{ path: "c.ts", content: "v1" }],
  ]);
  const byPath = Object.fromEntries(result.map((f) => [f.path, f.content]));
  assert.deepEqual(byPath, { "a.ts": "v2", "b.ts": "v1", "c.ts": "v1" });
});

test("publishDevAgentPullRequest refuses a run that is not yet 'succeeded'", async () => {
  const project = await prisma.project.findFirst();
  if (!project) assert.fail("No project found in local DB - this test requires a seeded local dev DB");
  const run = await prisma.devAgentRun.create({
    data: { projectId: project!.id, mode: "assigned", targetRepo: "testmind", status: "running", requestedBy: project!.ownerId },
  });
  try {
    await assert.rejects(() => publishDevAgentPullRequest(run.id), DevAgentPrError);
  } finally {
    await prisma.devAgentRun.deleteMany({ where: { id: run.id } });
  }
});

test("publishDevAgentPullRequest returns null (not an error) when no file changes were ever recorded", async () => {
  const project = await prisma.project.findFirst();
  if (!project) assert.fail("No project found in local DB - this test requires a seeded local dev DB");
  const run = await prisma.devAgentRun.create({
    data: { projectId: project!.id, mode: "assigned", targetRepo: "testmind", status: "succeeded", requestedBy: project!.ownerId },
  });
  try {
    const iteration = await prisma.devAgentIteration.create({
      data: { devAgentRunId: run.id, iterationNumber: 1, phase: "analyze", filesChanged: null as any },
    });
    const result = await publishDevAgentPullRequest(run.id);
    assert.equal(result, null);
    await prisma.devAgentIteration.delete({ where: { id: iteration.id } });
  } finally {
    await prisma.devAgentRun.deleteMany({ where: { id: run.id } });
  }
});

test("publishDevAgentPullRequest is idempotent: a run that already has a prUrl returns it without re-publishing", async () => {
  const project = await prisma.project.findFirst();
  if (!project) assert.fail("No project found in local DB - this test requires a seeded local dev DB");
  const run = await prisma.devAgentRun.create({
    data: { projectId: project!.id, mode: "assigned", targetRepo: "testmind", status: "succeeded", requestedBy: project!.ownerId, prUrl: "https://github.com/acme/widgets/pull/1" },
  });
  try {
    const result = await publishDevAgentPullRequest(run.id);
    assert.deepEqual(result, { prUrl: "https://github.com/acme/widgets/pull/1" });
  } finally {
    await prisma.devAgentRun.deleteMany({ where: { id: run.id } });
  }
});

test("dev-agent-pr.ts never calls a merge-related Octokit method - structural check, not behavioral", () => {
  const source = fs.readFileSync(new URL("./dev-agent-pr.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\.merge\(|mergePullRequest|pulls\.merge/i, "publishing a PR must never call any merge API - review is always required");
});
