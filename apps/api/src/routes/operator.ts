import type { FastifyInstance } from 'fastify';
import { getAuth } from '@clerk/fastify';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../prisma.js';
import { enqueueOperatorJob } from '../runner/queue.js';

const CreateJobBody = z.object({
  projectId: z.string().min(1),
  type: z.enum(['qa', 'security', 'repair', 'discovery']).default('qa'),
  objective: z.string().optional(),
  context: z.record(z.unknown()).optional(),
});

async function hydrateOperatorTasks<T extends {
  id: string;
  inputJson?: Prisma.JsonValue | null;
  tasks: Array<{
    id: string;
    inputJson?: Prisma.JsonValue | null;
    [key: string]: unknown;
  }>;
}>(jobs: T[]): Promise<Array<T & {
  tasks: Array<T["tasks"][number] & {
    resolvedTarget: {
      testResultId: string | null;
      testCaseId: string | null;
      testTitle: string | null;
      testCaseKey: string | null;
    } | null;
  }>;
}>> {
  const testResultIds = new Set<string>();
  const testCaseIds = new Set<string>();

  for (const job of jobs) {
    for (const task of job.tasks) {
      const input = (task.inputJson ?? null) as Record<string, unknown> | null;
      if (typeof input?.testResultId === "string" && input.testResultId.trim()) {
        testResultIds.add(input.testResultId);
      }
      if (typeof input?.testCaseId === "string" && input.testCaseId.trim()) {
        testCaseIds.add(input.testCaseId);
      }
    }
  }

  const [results, cases] = await Promise.all([
    testResultIds.size
      ? prisma.testResult.findMany({
          where: { id: { in: [...testResultIds] } },
          select: {
            id: true,
            testCaseId: true,
            testCase: { select: { id: true, key: true, title: true } },
          },
        })
      : Promise.resolve([]),
    testCaseIds.size
      ? prisma.testCase.findMany({
          where: { id: { in: [...testCaseIds] } },
          select: { id: true, key: true, title: true },
        })
      : Promise.resolve([]),
  ]);

  const resultById = new Map(results.map((row) => [row.id, row]));
  const caseById = new Map(cases.map((row) => [row.id, row]));

  return jobs.map((job) => ({
    ...job,
    tasks: job.tasks.map((task) => {
      const input = (task.inputJson ?? null) as Record<string, unknown> | null;
      const inputTestResultId =
        typeof input?.testResultId === "string" && input.testResultId.trim()
          ? input.testResultId
          : null;
      const inputTestCaseId =
        typeof input?.testCaseId === "string" && input.testCaseId.trim()
          ? input.testCaseId
          : null;
      const inputTestTitle =
        typeof input?.testTitle === "string" && input.testTitle.trim()
          ? input.testTitle
          : null;
      const result = inputTestResultId ? resultById.get(inputTestResultId) : null;
      const fallbackCaseId = result?.testCaseId ?? inputTestCaseId ?? null;
      const testCase = fallbackCaseId ? caseById.get(fallbackCaseId) ?? result?.testCase ?? null : result?.testCase ?? null;

      const resolvedTarget =
        inputTestResultId || fallbackCaseId || inputTestTitle || testCase?.key || testCase?.title
          ? {
              testResultId: inputTestResultId,
              testCaseId: fallbackCaseId,
              testTitle: inputTestTitle ?? testCase?.title ?? null,
              testCaseKey: testCase?.key ?? null,
            }
          : null;

      return {
        ...task,
        resolvedTarget,
      };
    }),
  }));
}

export default async function operatorRoutes(app: FastifyInstance) {
  // GET /operator/jobs — list jobs for the requesting user (most recent first)
  app.get('/operator/jobs', async (req, reply) => {
    const { userId } = getAuth(req);
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

    const { limit = '20', offset = '0' } = req.query as { limit?: string; offset?: string };
    const jobs = await prisma.operatorJob.findMany({
      where: { requestedBy: userId },
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
            inputJson: true,
            outputJson: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Number(limit) || 20, 100),
      skip: Number(offset) || 0,
    });
    return reply.send({ jobs: await hydrateOperatorTasks(jobs) });
  });

  // POST /operator/jobs — create and enqueue an operator job
  app.post('/operator/jobs', async (req, reply) => {
    const { userId } = getAuth(req);
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

    const parsed = CreateJobBody.safeParse(req.body);
    if (!parsed.success) return reply.code(422).send({ error: parsed.error.flatten() });

    const { projectId, type, objective, context } = parsed.data;

    const job = await prisma.operatorJob.create({
      data: {
        projectId,
        type,
        objective: objective ?? null,
        requestedBy: userId,
        contextJson: (context ?? {}) as Prisma.InputJsonValue,
      },
    });

    await enqueueOperatorJob(job.id);

    return reply.send({ job: { ...job, tasks: [] } });
  });

  // GET /operator/jobs/:id — fetch job + tasks + artifacts (owner only)
  app.get('/operator/jobs/:id', async (req, reply) => {
    const { userId } = getAuth(req);
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

    const { id } = req.params as { id: string };
    const job = await prisma.operatorJob.findUnique({
      where: { id },
      include: {
        tasks: true,
        artifacts: { select: { id: true, taskId: true, testRunId: true, type: true, path: true, metaJson: true, createdAt: true } },
      },
    });
    if (!job) return reply.code(404).send({ error: 'Not found' });
    if (job.requestedBy !== userId) return reply.code(403).send({ error: 'Forbidden' });

    // Extract rollup from contextJson._rollup (written by finalizeJob)
    const rollup = (job.contextJson as any)?._rollup ?? null;
    const [hydratedJob] = await hydrateOperatorTasks([job]);
    return reply.send({ job: hydratedJob, rollup });
  });

  // GET /operator/approvals?status=pending — UI polls this
  app.get('/operator/approvals', async (req, reply) => {
    const { userId } = getAuth(req);
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

    const { status = 'pending' } = req.query as { status?: string };
    const approvals = await prisma.operatorApproval.findMany({
      where: { status: status as any, job: { requestedBy: userId } },
      include: {
        job: { select: { id: true, projectId: true, type: true, objective: true } },
      },
      orderBy: { requestedAt: 'asc' },
    });
    return reply.send({ approvals });
  });

  // POST /operator/approvals/:id/approve
  app.post('/operator/approvals/:id/approve', async (req, reply) => {
    const { userId } = getAuth(req);
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

    const { id } = req.params as { id: string };
    const existing = await prisma.operatorApproval.findUnique({
      where: { id },
      include: { job: { select: { requestedBy: true } } },
    });
    if (!existing) return reply.code(404).send({ error: 'Not found' });
    if (existing.job.requestedBy !== userId) return reply.code(403).send({ error: 'Forbidden' });
    if (existing.status !== 'pending') return reply.code(409).send({ error: `Approval already ${existing.status}` });

    const approval = await prisma.operatorApproval.update({
      where: { id },
      data: { status: 'approved', resolvedBy: userId, resolvedAt: new Date() },
    });
    return reply.send({ approval });
  });

  // POST /operator/approvals/:id/deny
  app.post('/operator/approvals/:id/deny', async (req, reply) => {
    const { userId } = getAuth(req);
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

    const { id } = req.params as { id: string };
    const existing = await prisma.operatorApproval.findUnique({
      where: { id },
      include: { job: { select: { requestedBy: true } } },
    });
    if (!existing) return reply.code(404).send({ error: 'Not found' });
    if (existing.job.requestedBy !== userId) return reply.code(403).send({ error: 'Forbidden' });
    if (existing.status !== 'pending') return reply.code(409).send({ error: `Approval already ${existing.status}` });

    const approval = await prisma.operatorApproval.update({
      where: { id },
      data: { status: 'denied', resolvedBy: userId, resolvedAt: new Date() },
    });
    return reply.send({ approval });
  });
}
