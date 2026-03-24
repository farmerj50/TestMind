import type { FastifyInstance } from "fastify";
import { getAuth } from "@clerk/fastify";
import { z } from "zod";
import { prisma } from "../prisma.js";

export default async function qaAgentRoutes(app: FastifyInstance) {
  const StartBody = z.object({
    projectId: z.string().min(1, "projectId is required"),
    suiteId: z.string().min(1, "suiteId is required"),
    baseUrl: z.string().url().optional(),
    parallel: z.boolean().optional(),
    // includeApi removed — was broken (sent identical payload twice)
  });

  app.post("/qa-agent/start", async (req, reply) => {
    const { userId } = getAuth(req);
    if (!userId) return reply.code(401).send({ error: "Unauthorized" });

    const parsed = StartBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(422).send({ error: parsed.error.flatten() });
    }

    const { projectId, suiteId, baseUrl } = parsed.data;

    // Delegate to /runner/run so suiteId → spec file resolution happens correctly.
    // run.ts looks up curatedSuite, resolves the file path, creates the TestRun, and
    // enqueues it — we reuse all of that rather than duplicating it here.
    const authHeader =
      (req.headers.authorization as string | undefined) ||
      (req.headers.Authorization as string | undefined);

    const res = await app.inject({
      method: "POST",
      url: "/runner/run",
      payload: { projectId, suiteId, baseUrl },
      headers: authHeader ? { authorization: authHeader } : undefined,
    });

    if (res.statusCode < 200 || res.statusCode >= 300) {
      return reply.code(res.statusCode).send({ error: res.body?.toString() ?? "Runner failed" });
    }

    let runId: string | undefined;
    try {
      runId = (res.json() as any)?.id;
    } catch {
      // ignore parse errors
    }

    if (!runId) {
      return reply.code(502).send({ error: "Runner did not return a run ID" });
    }

    // Stamp trigger so qa-agent jobs are queryable separately from user-initiated runs.
    await prisma.testRun.update({ where: { id: runId }, data: { trigger: 'qa-agent' } });

    // Read the freshly-created TestRun from DB and return it as the job.
    // From here on, job.id === runId so polling /qa-agent/jobs/:id reads directly from DB.
    const run = await prisma.testRun.findUnique({
      where: { id: runId },
      select: {
        id: true,
        projectId: true,
        status: true,
        error: true,
        createdAt: true,
        startedAt: true,
        finishedAt: true,
        paramsJson: true,
      },
    });

    return reply.send({ job: toJobShape(run ?? { id: runId, projectId, status: "queued", error: null, createdAt: new Date(), startedAt: null, finishedAt: null, paramsJson: null }) });
  });

  app.get("/qa-agent/jobs/:id", async (req, reply) => {
    const { userId } = getAuth(req);
    if (!userId) return reply.code(401).send({ error: "Unauthorized" });

    const { id } = req.params as { id: string };
    const run = await prisma.testRun.findUnique({
      where: { id },
      select: {
        id: true,
        projectId: true,
        status: true,
        error: true,
        createdAt: true,
        startedAt: true,
        finishedAt: true,
        paramsJson: true,
      },
    });

    if (!run) return reply.code(404).send({ error: "Job not found" });
    return reply.send({ job: toJobShape(run) });
  });
}

function toJobShape(run: {
  id: string;
  projectId: string;
  status: string;
  error?: string | null;
  createdAt: Date;
  startedAt?: Date | null;
  finishedAt?: Date | null;
  paramsJson?: unknown;
}) {
  const params = (run.paramsJson ?? {}) as Record<string, any>;
  return {
    id: run.id,
    projectId: run.projectId,
    status: run.status,
    // runId === id so the UI "View report" link (/test-runs/:runId) resolves correctly
    runId: run.id,
    baseUrl: params.baseUrl ?? undefined,
    parallel: params.parallel ?? false,
    error: run.error ?? undefined,
    createdAt: run.createdAt.toISOString(),
    // synthesized from the most recent state change timestamp
    updatedAt: (run.finishedAt ?? run.startedAt ?? run.createdAt).toISOString(),
  };
}
