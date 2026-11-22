// apps/api/src/routes/devAgent.ts
// Autonomous Development Mode (Stage E). Cloned from routes/evaluations.ts's shape - a run +
// nested history, ownership-checked on every route.

import type { FastifyInstance } from "fastify";
import { getAuth } from "@clerk/fastify";
import { z } from "zod";
import { prisma } from "../prisma.js";
import { isProjectOwner } from "../lib/project-access.js";
import { enqueueOperatorJob } from "../runner/queue.js";
import { buildInstructionText } from "../lib/dev-agent-self-improvement.js";
import { publishDevAgentPullRequest, DevAgentPrError } from "../lib/dev-agent-pr.js";

function requireUser(req: any, reply: any): string | null {
  const { userId } = getAuth(req);
  if (!userId) {
    reply.code(401).send({ error: "Unauthorized" });
    return null;
  }
  return userId;
}

// No implicit external-repo access: pulled out as its own pure function so the rule is
// directly unit-testable without booting the route/HTTP layer.
export function requiresExternalRepoConfirmation(targetRepo: string, confirmExternalRepo?: boolean): boolean {
  return targetRepo !== "testmind" && !confirmExternalRepo;
}

const CreateRunBody = z.object({
  projectId: z.string().min(1),
  mode: z.enum(["assigned", "selfImprovement", "both"]).default("assigned"),
  // No implicit external-repo access: anything other than the default "testmind" requires
  // the caller to explicitly set confirmExternalRepo: true in the same request.
  targetRepo: z.string().min(1).default("testmind"),
  confirmExternalRepo: z.boolean().optional(),
  instructionText: z.string().max(20000).optional(),
  budgetUsd: z.number().positive().optional(),
  maxIterations: z.number().int().min(1).max(50).optional(),
  testCommand: z.string().max(2000).optional(),
  scheduledStartAt: z.string().datetime().optional(),
  timezone: z.string().max(100).optional(),
});

export async function devAgentRoutes(app: FastifyInstance) {
  app.post("/dev-agent/runs", async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;

    const parsed = CreateRunBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const body = parsed.data;

    if (!(await isProjectOwner(body.projectId, userId))) return reply.code(403).send({ error: "Forbidden" });

    if (requiresExternalRepoConfirmation(body.targetRepo, body.confirmExternalRepo)) {
      return reply.code(400).send({
        error: "Targeting a repository other than 'testmind' requires explicit confirmExternalRepo: true in the request - there is no implicit external-repo access.",
      });
    }

    const instructionText = await buildInstructionText(body.mode, body.projectId, body.instructionText ?? null);

    const run = await prisma.devAgentRun.create({
      data: {
        projectId: body.projectId,
        mode: body.mode,
        targetRepo: body.targetRepo,
        instructionText,
        budgetUsd: body.budgetUsd,
        maxIterations: body.maxIterations ?? undefined,
        testCommand: body.testCommand,
        scheduledStartAt: body.scheduledStartAt ? new Date(body.scheduledStartAt) : null,
        timezone: body.timezone,
        requestedBy: userId,
      },
    });

    if (body.instructionText) {
      await prisma.devAgentMessage.create({
        data: { devAgentRunId: run.id, role: "user", content: body.instructionText },
      });
    }

    // Scheduled runs are registered as a one-shot-template schedule rather than enqueued now;
    // the scheduler's worker creates the *next* real DevAgentRun from this template each time
    // it fires (see scheduler.ts). The run we just created above acts as that template's record
    // for this initial request; it stays 'queued' and is never ticked by the operator worker
    // until a schedule actually fires it, so there is no immediate dispatch for it here.
    if (!body.scheduledStartAt) {
      const operatorJob = await prisma.operatorJob.create({
        data: {
          projectId: body.projectId,
          type: "autonomousDev",
          objective: `Autonomous Dev Mode (${body.mode}): ${body.targetRepo}`,
          requestedBy: userId,
          contextJson: { devAgentRunId: run.id },
        },
      });
      await prisma.devAgentRun.update({ where: { id: run.id }, data: { operatorJobId: operatorJob.id } });
      await enqueueOperatorJob(operatorJob.id, { durable: true });
      return reply.code(202).send({ run: { ...run, operatorJobId: operatorJob.id } });
    }

    return reply.code(202).send({ run });
  });

  app.get("/dev-agent/runs", async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;

    const Query = z.object({ projectId: z.string().min(1) });
    const parsed = Query.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    if (!(await isProjectOwner(parsed.data.projectId, userId))) return reply.code(403).send({ error: "Forbidden" });

    const runs = await prisma.devAgentRun.findMany({
      where: { projectId: parsed.data.projectId },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    return reply.send({ runs });
  });

  app.get<{ Params: { id: string } }>("/dev-agent/runs/:id", async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;

    const run = await prisma.devAgentRun.findUnique({
      where: { id: req.params.id },
      include: { iterations: { orderBy: { iterationNumber: "asc" } }, messages: { orderBy: { createdAt: "asc" } } },
    });
    if (!run) return reply.code(404).send({ error: "Run not found" });
    if (!(await isProjectOwner(run.projectId, userId))) return reply.code(403).send({ error: "Forbidden" });

    return reply.send({ run });
  });

  async function loadOwnedRun(req: any, reply: any) {
    const userId = requireUser(req, reply);
    if (!userId) return null;
    const run = await prisma.devAgentRun.findUnique({ where: { id: req.params.id } });
    if (!run) {
      reply.code(404).send({ error: "Run not found" });
      return null;
    }
    if (!(await isProjectOwner(run.projectId, userId))) {
      reply.code(403).send({ error: "Forbidden" });
      return null;
    }
    return run;
  }

  app.post<{ Params: { id: string } }>("/dev-agent/runs/:id/pause", async (req, reply) => {
    const run = await loadOwnedRun(req, reply);
    if (!run) return;
    if (run.status !== "running") return reply.code(409).send({ error: `Cannot pause a run with status '${run.status}'` });
    const updated = await prisma.devAgentRun.update({ where: { id: run.id }, data: { status: "paused" } });
    return reply.send({ run: updated });
  });

  app.post<{ Params: { id: string } }>("/dev-agent/runs/:id/resume", async (req, reply) => {
    const run = await loadOwnedRun(req, reply);
    if (!run) return;
    if (run.status !== "paused") return reply.code(409).send({ error: `Cannot resume a run with status '${run.status}'` });
    const updated = await prisma.devAgentRun.update({ where: { id: run.id }, data: { status: "running" } });
    // The state machine's own paused-check re-delays itself every PAUSE_RECHECK_MS; nudging
    // it here just lets resume take effect sooner rather than waiting out that interval.
    if (run.operatorJobId) await enqueueOperatorJob(run.operatorJobId, { durable: true }).catch(() => {});
    return reply.send({ run: updated });
  });

  app.post<{ Params: { id: string } }>("/dev-agent/runs/:id/stop", async (req, reply) => {
    const run = await loadOwnedRun(req, reply);
    if (!run) return;
    if (["succeeded", "failed", "canceled"].includes(run.status)) {
      return reply.code(409).send({ error: `Run already terminal ('${run.status}')` });
    }
    const updated = await prisma.devAgentRun.update({ where: { id: run.id }, data: { status: "canceled", finishedAt: new Date() } });
    if (run.operatorJobId) await prisma.operatorJob.update({ where: { id: run.operatorJobId }, data: { status: "canceled" } }).catch(() => {});
    return reply.send({ run: updated });
  });

  // Emergency stop: same checkpoint-based cancel as /stop. dev-agent-worker.ts's
  // runConfiguredTestCommand already polls DevAgentRun.status every 1s and SIGKILLs its
  // in-flight subprocess the moment status becomes 'canceled' - setting that same status
  // is sufficient to reach the subprocess; there is no separate live-process handle this
  // HTTP route could signal more directly (the subprocess runs inside a different worker
  // process entirely). Documented here rather than inventing a fake "instant" mechanism.
  app.post<{ Params: { id: string } }>("/dev-agent/runs/:id/emergency-stop", async (req, reply) => {
    const run = await loadOwnedRun(req, reply);
    if (!run) return;
    if (["succeeded", "failed", "canceled"].includes(run.status)) {
      return reply.code(409).send({ error: `Run already terminal ('${run.status}')` });
    }
    const updated = await prisma.devAgentRun.update({ where: { id: run.id }, data: { status: "canceled", finishedAt: new Date(), error: "Emergency stop requested" } });
    if (run.operatorJobId) await prisma.operatorJob.update({ where: { id: run.operatorJobId }, data: { status: "canceled" } }).catch(() => {});
    return reply.send({ run: updated });
  });

  const PostMessageBody = z.object({ content: z.string().min(1).max(20000) });

  app.post<{ Params: { id: string } }>("/dev-agent/runs/:id/messages", async (req, reply) => {
    const run = await loadOwnedRun(req, reply);
    if (!run) return;
    const parsed = PostMessageBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

    const message = await prisma.devAgentMessage.create({
      data: { devAgentRunId: run.id, role: "user", content: parsed.data.content },
    });
    // Nudge the worker so a follow-up instruction is picked up sooner rather than waiting
    // out the next scheduled re-delay, same idiom as /resume above.
    if (run.operatorJobId && run.status === "running") {
      await enqueueOperatorJob(run.operatorJobId, { durable: true }).catch(() => {});
    }
    return reply.code(201).send({ message });
  });

  app.get<{ Params: { id: string } }>("/dev-agent/runs/:id/messages", async (req, reply) => {
    const run = await loadOwnedRun(req, reply);
    if (!run) return;
    const messages = await prisma.devAgentMessage.findMany({
      where: { devAgentRunId: run.id },
      orderBy: { createdAt: "asc" },
    });
    return reply.send({ messages });
  });

  app.get<{ Params: { id: string } }>("/dev-agent/runs/:id/summary", async (req, reply) => {
    const run = await loadOwnedRun(req, reply);
    if (!run) return;
    const iterations = await prisma.devAgentIteration.findMany({
      where: { devAgentRunId: run.id },
      orderBy: { iterationNumber: "asc" },
    });

    const filesChanged = new Set<string>();
    for (const it of iterations) {
      if (Array.isArray(it.filesChanged)) {
        for (const f of it.filesChanged as any[]) {
          if (f && typeof f === "object" && typeof f.path === "string") filesChanged.add(f.path);
        }
      }
    }
    const latest = iterations[iterations.length - 1] ?? null;

    return reply.send({
      summary: {
        status: run.status,
        iterationCount: iterations.length,
        filesChanged: [...filesChanged],
        latestTestResult: latest?.testResult ?? null,
        spentUsd: run.spentUsd,
        budgetUsd: run.budgetUsd,
        prUrl: run.prUrl,
        awaitingReview: run.status === "succeeded" && !!run.prUrl,
        iterations: iterations.map((i) => ({
          iterationNumber: i.iterationNumber,
          phase: i.phase,
          summary: i.summary,
          filesChanged: i.filesChanged,
          testResult: i.testResult,
          costUsd: i.costUsd,
          createdAt: i.createdAt,
        })),
      },
    });
  });

  // Never automatic/implicit: the caller (UI) explicitly triggers publishing, and the
  // underlying flow never merges - it only ever opens/updates a draft PR for human review.
  app.post<{ Params: { id: string } }>("/dev-agent/runs/:id/publish-pr", async (req, reply) => {
    const run = await loadOwnedRun(req, reply);
    if (!run) return;
    try {
      const result = await publishDevAgentPullRequest(run.id);
      if (!result) return reply.code(409).send({ error: "No file changes recorded for this run yet" });
      return reply.send({ prUrl: result.prUrl });
    } catch (err) {
      if (err instanceof DevAgentPrError) return reply.code(409).send({ error: err.message });
      throw err;
    }
  });

  // Scheduling itself is handled by the existing routes/schedules.ts (POST/GET/PATCH/DELETE
  // /schedules) - extended there (not duplicated here) to accept `timezone`. A caller
  // schedules a Dev Agent run by POSTing to /schedules with
  // contextJson: { devAgentTemplate: {...} } - that route already accepted arbitrary
  // contextJson before this stage; scheduler.ts's worker now interprets devAgentTemplate
  // when present instead of always creating a type:'qa' job.
}

export default devAgentRoutes;
