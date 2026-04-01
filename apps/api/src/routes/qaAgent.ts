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

  /**
   * Journey 2: Launch QA agent via the operator job system.
   *
   * Previously delegated to /runner/run (single-run thin wrapper). Now creates
   * an OperatorJob of type "qa" so the operator worker can orchestrate the full
   * detect → classify → heal/escalate → verify → regression lifecycle.
   */
  app.post("/qa-agent/start", async (req, reply) => {
    const { userId } = getAuth(req);
    if (!userId) return reply.code(401).send({ error: "Unauthorized" });

    const parsed = StartBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(422).send({ error: parsed.error.flatten() });
    }

    const { projectId: rawProjectId, suiteId, baseUrl } = parsed.data;

    // Use the suite's projectId as authoritative — prevents cross-project mismatch
    // when the UI's project dropdown doesn't match the selected suite's project.
    const suite = await prisma.curatedSuite.findUnique({
      where: { id: suiteId },
      select: { projectId: true, project: { select: { ownerId: true } } },
    });
    if (!suite || suite.project.ownerId !== userId) {
      return reply.code(404).send({ error: "Suite not found" });
    }
    const projectId = suite.projectId;

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

    return reply.send({
      job: {
        id: job.id,
        projectId,
        // runId is null until the operator worker creates the TestRun
        runId: null,
        status: job.status,
        baseUrl: baseUrl ?? undefined,
        parallel: parsed.data.parallel ?? false,
        error: undefined,
        createdAt: job.createdAt.toISOString(),
        updatedAt: job.createdAt.toISOString(),
      },
    });
  });

  /**
   * Poll QA agent job status. Returns OperatorJob + its tasks so the UI can
   * surface the current phase (execute → triage → repair → verify) and link
   * to the underlying TestRun report once it exists.
   */
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

    // Surface the most recent TestRun linked by any task so the UI "View report" link works
    const latestRunTask = [...job.tasks].reverse().find((t) => !!t.testRunId);
    const ctx = (job.contextJson ?? {}) as Record<string, any>;

    return reply.send({
      job: {
        id: job.id,
        projectId: job.projectId,
        status: job.status,
        runId: latestRunTask?.testRunId ?? null,
        baseUrl: ctx.baseUrl ?? undefined,
        parallel: ctx.parallel ?? false,
        error: job.error ?? undefined,
        createdAt: job.createdAt.toISOString(),
        updatedAt: (job.finishedAt ?? job.startedAt ?? job.createdAt).toISOString(),
        tasks: job.tasks,
      },
    });
  });
}
