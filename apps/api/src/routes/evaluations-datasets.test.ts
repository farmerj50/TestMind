import test from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import { workflowDigest as datasetDigest } from "../lib/workflow-version.js";

// Phase 3: versioned golden datasets. index.ts can't be booted from a test (see
// reports-summary-counts.test.ts's note), so this exercises the route's exact persistence
// idiom (digest-dedup-on-create, same as saveWorkflowVersion) directly against a real local DB.

const prisma = new PrismaClient();

test("creating a dataset version twice with identical cases dedupes to the same version row", async () => {
  const project = await prisma.project.findFirst();
  if (!project) {
    assert.fail("No project found in local DB - this test requires a seeded local dev DB");
  }
  const dataset = await prisma.evaluationDataset.create({ data: { projectId: project!.id, name: "test-dedup-dataset" } });
  try {
    const cases = [{ case_id: "c1", answer_text: "Paris", required_facts: ["Paris"] }];
    const digest = datasetDigest(cases);

    const v1 = await prisma.evaluationDatasetVersion.upsert({
      where: { datasetId_digest: { datasetId: dataset.id, digest } },
      create: { datasetId: dataset.id, digest, casesJson: cases, createdBy: project!.ownerId },
      update: {},
    });
    const v2 = await prisma.evaluationDatasetVersion.upsert({
      where: { datasetId_digest: { datasetId: dataset.id, digest } },
      create: { datasetId: dataset.id, digest, casesJson: cases, createdBy: project!.ownerId },
      update: {},
    });
    assert.equal(v1.id, v2.id, "identical cases content must dedupe to the same version, not create a second row");

    const count = await prisma.evaluationDatasetVersion.count({ where: { datasetId: dataset.id } });
    assert.equal(count, 1);
  } finally {
    await prisma.evaluationDatasetVersion.deleteMany({ where: { datasetId: dataset.id } });
    await prisma.evaluationDataset.deleteMany({ where: { id: dataset.id } });
  }
});

test("creating a dataset version with different cases content creates a new, separate version", async () => {
  const project = await prisma.project.findFirst();
  if (!project) {
    assert.fail("No project found in local DB - this test requires a seeded local dev DB");
  }
  const dataset = await prisma.evaluationDataset.create({ data: { projectId: project!.id, name: "test-separate-versions-dataset" } });
  try {
    const casesA = [{ case_id: "c1", answer_text: "Paris" }];
    const casesB = [{ case_id: "c1", answer_text: "London" }];
    const digestA = datasetDigest(casesA);
    const digestB = datasetDigest(casesB);
    assert.notEqual(digestA, digestB);

    await prisma.evaluationDatasetVersion.create({ data: { datasetId: dataset.id, digest: digestA, casesJson: casesA, createdBy: project!.ownerId } });
    await prisma.evaluationDatasetVersion.create({ data: { datasetId: dataset.id, digest: digestB, casesJson: casesB, createdBy: project!.ownerId } });

    const count = await prisma.evaluationDatasetVersion.count({ where: { datasetId: dataset.id } });
    assert.equal(count, 2);
  } finally {
    await prisma.evaluationDatasetVersion.deleteMany({ where: { datasetId: dataset.id } });
    await prisma.evaluationDataset.deleteMany({ where: { id: dataset.id } });
  }
});

test("a dataset version immutably retains its casesJson once created", async () => {
  const project = await prisma.project.findFirst();
  if (!project) {
    assert.fail("No project found in local DB - this test requires a seeded local dev DB");
  }
  const dataset = await prisma.evaluationDataset.create({ data: { projectId: project!.id, name: "test-immutable-dataset" } });
  try {
    const cases = [{ case_id: "c1", answer_text: "Paris" }];
    const version = await prisma.evaluationDatasetVersion.create({
      data: { datasetId: dataset.id, digest: datasetDigest(cases), casesJson: cases, createdBy: project!.ownerId },
    });
    const reread = await prisma.evaluationDatasetVersion.findUnique({ where: { id: version.id } });
    assert.deepEqual(reread?.casesJson, cases);
  } finally {
    await prisma.evaluationDatasetVersion.deleteMany({ where: { datasetId: dataset.id } });
    await prisma.evaluationDataset.deleteMany({ where: { id: dataset.id } });
  }
});
