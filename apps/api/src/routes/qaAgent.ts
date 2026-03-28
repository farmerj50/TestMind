import type { FastifyInstance } from "fastify";
import { getAuth } from "@clerk/fastify";
import { z } from "zod";
import { prisma } from "../prisma.js";
import { enqueueOperatorJob } from "../runner/queue.js";

export default async function qaAgentRoutes(app: FastifyInstance) {
  const StartBody = z.object({
    projectId: z.string().min(1, "projectId is required"),
    suiteId: z.string().min(1, "suiteId is required"),
    baseUrl: z.string().url().optional(),
    parallel: z.boolean().optional(),
  });

  // POST /qa-agent/start
  // Creates an OperatorJob of type "qa" so the full triage/repair/verify
  // lifecycle runs through the operator worker instead of a thin runner wrapper.
  app.post("/qa-agent/start", async (req, reply) => {
    const { userId } = getAuth(req);
    if (!userId) return reply.code(401).send({ error: "Unauthorized" });

    const parsed = StartBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(422).send({ error: parsed.error.flatten() });
    }

    const { projectId, suiteId, baseUrl } = parsed.data;

    const job = await prisma.operatorJob.create({
      data: {
        projectId,
        type: "qa",
        requestedBy: userId,
        objective: "Execute QA suite and manage failure lifecycle",
        contextJson: {
          suiteId,
          baseUrl: baseUrl ?? null,
          parallel: parsed.data.parallel ?? false,
          source: "qa-agent",
        },
      },
    });

    await enqueueOperatorJob(job.id);

    return reply.send({ job: toJobShape(job, null) });
  });

  // GET /qa-agent/jobs/:id
  // Returns the OperatorJob plus its tasks. The UI can follow runId from
  // the latest execute task to render the run report as before.
  app.get("/qa-agent/jobs/:id", async (req, reply) => {
    const { userId } = getAuth(req);
    if (!userId) return reply.code(401).send({ error: "Unauthorized" });

    const { id } = req.params as { id: string };

    const job = await prisma.operatorJob.findUnique({
      where: { id },
      include: {
        tasks: {
          select: {
            id: true,
            type: true,
            status: true,
            testRunId: true,
            error: true,
            createdAt: true,
            startedAt: true,
            finishedAt: true,
            outputJson: true,
          },
          orderBy: { createdAt: "asc" },
        },
      },
    });

    if (!job) return reply.code(404).send({ error: "Job not found" });
    if (job.requestedBy !== userId) return reply.code(403).send({ error: "Forbidden" });

    // Surface the most recent execute task's runId so the UI "View report"
    // link (/test-runs/:runId) continues to work unchanged.
    const latestRunTask = [...job.tasks].reverse().find((t) => !!t.testRunId);

    return reply.send({
      job: {
        ...toJobShape(job, latestRunTask?.testRunId ?? null),
        tasks: job.tasks,
      },
    });
  });
}

function toJobShape(
  job: {
    id: string;
    projectId: string;
    status: string;
    error?: string | null;
    createdAt: Date;
    startedAt?: Date | null;
    finishedAt?: Date | null;
    contextJson?: unknown;
  },
  runId: string | null
) {
  const ctx = (job.contextJson ?? {}) as Record<string, any>;
  return {
    id: job.id,
    projectId: job.projectId,
    status: job.status,
    runId,
    baseUrl: ctx.baseUrl ?? undefined,
    parallel: ctx.parallel ?? false,
    error: job.error ?? undefined,
    createdAt: job.createdAt.toISOString(),
    updatedAt: (job.finishedAt ?? job.startedAt ?? job.createdAt).toISOString(),
  };
}
