// apps/api/src/routes/evaluations.ts
// Evaluation Engine v1 (Phase 1). Cloned from routes/apiTesting.ts's shape - a run + nested
// per-case results, ownership-checked on every route.

import type { FastifyInstance } from "fastify";
import { getAuth } from "@clerk/fastify";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../prisma.js";
import { isProjectOwner } from "../lib/project-access.js";
import { enqueueEvaluationRun } from "../runner/queue.js";
// Phase 3: golden dataset version digest - reuses the existing canonical-JSON + sha256 digest
// (workflowDigest is generic despite the name; see lib/workflow-version.ts) rather than
// duplicating it, so identical cases[] content always dedupes to the same version.
import { workflowDigest as datasetDigest } from "../lib/workflow-version.js";
import { recordAuditLog } from "../lib/audit-log.js";

// Data-minimization correction: caps mirror apps/eval-service/eval_service/schemas.py's own
// limits so an oversized request is rejected here, before it's ever persisted or queued, not
// just at the eval-service boundary.
const MAX_CASES_PER_REQUEST = 2_000;

function requireUser(req: any, reply: any): string | null {
  const { userId } = getAuth(req);
  if (!userId) {
    reply.code(401).send({ error: "Unauthorized" });
    return null;
  }
  return userId;
}

const GateThresholdSchema = z.object({
  k: z.number().int().min(1).max(1000).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
});

const EvaluationCaseSchema = z.record(z.string(), z.unknown());

export async function evaluationRoutes(app: FastifyInstance) {
  app.post("/evaluations/runs", async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;

    const Body = z.object({
      projectId: z.string().min(1),
      datasetId: z.string().min(1),
      datasetVersion: z.string().min(1),
      applicationId: z.string().min(1),
      applicationVersion: z.string().min(1),
      gates: z.record(z.string(), GateThresholdSchema).optional(),
      cases: z.array(EvaluationCaseSchema).min(1).max(MAX_CASES_PER_REQUEST),
    });
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const { projectId, datasetId, datasetVersion, applicationId, applicationVersion, gates, cases } = parsed.data;

    if (!(await isProjectOwner(projectId, userId))) return reply.code(403).send({ error: "Forbidden" });

    const run = await prisma.evaluationRun.create({
      data: {
        projectId,
        datasetId,
        datasetVersion,
        applicationId,
        applicationVersion,
        gatesConfig: (gates as Prisma.InputJsonValue) ?? undefined,
        casesJson: cases as Prisma.InputJsonValue,
        status: "queued",
      },
    });

    await enqueueEvaluationRun({ runId: run.id, projectId });
    await recordAuditLog({ projectId, actorId: userId, action: "evaluation_run.created", targetType: "EvaluationRun", targetId: run.id });
    return reply.code(202).send({ runId: run.id });
  });

  app.get<{ Params: { id: string } }>("/evaluations/runs/:id", async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;

    const run = await prisma.evaluationRun.findUnique({
      where: { id: req.params.id },
      include: { results: { orderBy: { createdAt: "asc" } } },
    });
    if (!run) return reply.code(404).send({ error: "Run not found" });
    if (!(await isProjectOwner(run.projectId, userId))) return reply.code(403).send({ error: "Forbidden" });

    const openHumanReviewCount = await prisma.humanInterventionCandidate.count({
      where: {
        projectId: run.projectId,
        source: "evaluation-llm-judged",
        status: "open",
        contextJson: { path: ["evaluationRunId"], equals: run.id },
      },
    });

    return reply.send({ run: { ...run, openHumanReviewCount } });
  });

  app.get("/evaluations/runs", async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;

    const Query = z.object({ projectId: z.string().min(1) });
    const parsed = Query.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    if (!(await isProjectOwner(parsed.data.projectId, userId))) return reply.code(403).send({ error: "Forbidden" });

    const runs = await prisma.evaluationRun.findMany({
      where: { projectId: parsed.data.projectId },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    return reply.send({ runs });
  });

  // ── Phase 3: versioned golden datasets ──────────────────────────────────────

  app.post("/evaluations/datasets", async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;

    const Body = z.object({
      projectId: z.string().min(1),
      name: z.string().min(1),
      cases: z.array(EvaluationCaseSchema).min(1).max(MAX_CASES_PER_REQUEST),
    });
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const { projectId, name, cases } = parsed.data;
    if (!(await isProjectOwner(projectId, userId))) return reply.code(403).send({ error: "Forbidden" });

    const dataset = await prisma.evaluationDataset.create({ data: { projectId, name } });
    const digest = datasetDigest(cases);
    const version = await prisma.evaluationDatasetVersion.create({
      data: { datasetId: dataset.id, digest, casesJson: cases as Prisma.InputJsonValue, createdBy: userId },
    });
    await recordAuditLog({ projectId, actorId: userId, action: "evaluation_dataset_version.created", targetType: "EvaluationDatasetVersion", targetId: version.id, metadataJson: { datasetId: dataset.id, digest } });
    return reply.code(201).send({ dataset, version });
  });

  app.post<{ Params: { id: string } }>("/evaluations/datasets/:id/versions", async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;

    const dataset = await prisma.evaluationDataset.findUnique({ where: { id: req.params.id } });
    if (!dataset) return reply.code(404).send({ error: "Dataset not found" });
    if (!(await isProjectOwner(dataset.projectId, userId))) return reply.code(403).send({ error: "Forbidden" });

    const Body = z.object({ cases: z.array(EvaluationCaseSchema).min(1).max(MAX_CASES_PER_REQUEST) });
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

    const digest = datasetDigest(parsed.data.cases);
    // Same dedup-on-create idiom as saveWorkflowVersion: identical content never creates a
    // redundant row, but existing content is never silently overwritten (immutable snapshot).
    const version = await prisma.evaluationDatasetVersion.upsert({
      where: { datasetId_digest: { datasetId: dataset.id, digest } },
      create: { datasetId: dataset.id, digest, casesJson: parsed.data.cases as Prisma.InputJsonValue, createdBy: userId },
      update: {},
    });
    await recordAuditLog({ projectId: dataset.projectId, actorId: userId, action: "evaluation_dataset_version.created", targetType: "EvaluationDatasetVersion", targetId: version.id, metadataJson: { datasetId: dataset.id, digest } });
    return reply.code(201).send({ version });
  });

  app.get("/evaluations/datasets", async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;

    const Query = z.object({ projectId: z.string().min(1) });
    const parsed = Query.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    if (!(await isProjectOwner(parsed.data.projectId, userId))) return reply.code(403).send({ error: "Forbidden" });

    const datasets = await prisma.evaluationDataset.findMany({
      where: { projectId: parsed.data.projectId },
      orderBy: { createdAt: "desc" },
      include: { versions: { orderBy: { createdAt: "desc" }, select: { id: true, digest: true, createdAt: true, createdBy: true } } },
    });
    return reply.send({ datasets });
  });

  app.get<{ Params: { id: string; versionId: string } }>("/evaluations/datasets/:id/versions/:versionId", async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;

    const version = await prisma.evaluationDatasetVersion.findFirst({
      where: { id: req.params.versionId, datasetId: req.params.id },
      include: { dataset: true },
    });
    if (!version) return reply.code(404).send({ error: "Dataset version not found" });
    if (!(await isProjectOwner(version.dataset.projectId, userId))) return reply.code(403).send({ error: "Forbidden" });

    return reply.send({ version });
  });
}

export default evaluationRoutes;
