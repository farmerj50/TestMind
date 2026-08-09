import type { FastifyInstance } from "fastify";
import { getAuth } from "@clerk/fastify";
import { z } from "zod";
import { prisma } from "../prisma.js";
import { enqueueOperatorJob } from "../runner/queue.js";
import { validatedEnv } from "../config/env.js";

export default async function qaAgentRoutes(app: FastifyInstance) {
  const StartBody = z.object({
    projectId: z.string().min(1, "projectId is required"),
    suiteId: z.string().min(1, "suiteId is required").optional(),
    baseUrl: z.string().url().optional(),
    parallel: z.boolean().optional(),
    autonomous: z.boolean().optional(),
    enableGitHubWriteback: z.boolean().optional(),
  });

  app.get("/qa-agent/capabilities", async (req, reply) => {
    const { userId } = getAuth(req);
    if (!userId) return reply.code(401).send({ error: "Unauthorized" });

    return reply.send({
      autonomousQaEnabled: validatedEnv.TM_AUTONOMOUS_QA_ENABLED,
    });
  });

  app.post("/qa-agent/start", async (req, reply) => {
    const { userId } = getAuth(req);
    if (!userId) return reply.code(401).send({ error: "Unauthorized" });

    const parsed = StartBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(422).send({ error: parsed.error.flatten() });
    }

    const { projectId: rawProjectId, suiteId, baseUrl } = parsed.data;
    const autonomous = parsed.data.autonomous === true;
    const enableGitHubWriteback = parsed.data.enableGitHubWriteback === true;

    let projectId = rawProjectId;
    if (autonomous) {
      if (!validatedEnv.TM_AUTONOMOUS_QA_ENABLED) {
        return reply.code(403).send({ error: "Autonomous QA is not enabled" });
      }

      const project = await prisma.project.findFirst({
        where: { id: rawProjectId, ownerId: userId },
        select: { id: true },
      });
      if (!project) return reply.code(404).send({ error: "Project not found" });

      if (suiteId) {
        const suite = await prisma.curatedSuite.findFirst({
          where: { id: suiteId, projectId: project.id },
          select: { id: true },
        });
        if (!suite) return reply.code(404).send({ error: "Suite not found" });
      }
      projectId = project.id;
    } else {
      if (!suiteId) {
        return reply.code(422).send({ error: { fieldErrors: { suiteId: ["suiteId is required"] } } });
      }

      const suite = await prisma.curatedSuite.findUnique({
        where: { id: suiteId },
        select: { projectId: true, project: { select: { ownerId: true } } },
      });
      if (!suite || suite.project.ownerId !== userId) {
        return reply.code(404).send({ error: "Suite not found" });
      }
      projectId = suite.projectId;
    }

    const job = await prisma.operatorJob.create({
      data: {
        projectId,
        type: "qa",
        requestedBy: userId,
        objective: autonomous
          ? "Run autonomous QA discovery, generation, repair, and verification"
          : "Execute QA suite and manage failure lifecycle",
        contextJson: {
          suiteId: suiteId ?? null,
          baseUrl: baseUrl ?? null,
          parallel: parsed.data.parallel ?? false,
          autonomous,
          enableGitHubWriteback: autonomous ? enableGitHubWriteback : true,
          disableAutoSelfHeal: autonomous,
          source: "qa-agent",
        },
      },
    });

    await enqueueOperatorJob(job.id);

    return reply.send({
      job: {
        id: job.id,
        projectId,
        runId: null,
        status: job.status,
        baseUrl: baseUrl ?? undefined,
        parallel: parsed.data.parallel ?? false,
        autonomous,
        error: undefined,
        createdAt: job.createdAt.toISOString(),
        updatedAt: job.createdAt.toISOString(),
      },
    });
  });

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
        autonomous: ctx.autonomous === true,
        error: job.error ?? undefined,
        createdAt: job.createdAt.toISOString(),
        updatedAt: (job.finishedAt ?? job.startedAt ?? job.createdAt).toISOString(),
        tasks: job.tasks,
      },
    });
  });
}
