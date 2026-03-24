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

export default async function operatorRoutes(app: FastifyInstance) {
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

  // GET /operator/jobs/:id — fetch job + tasks
  app.get('/operator/jobs/:id', async (req, reply) => {
    const { userId } = getAuth(req);
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

    const { id } = req.params as { id: string };
    const job = await prisma.operatorJob.findUnique({
      where: { id },
      include: { tasks: true },
    });
    if (!job) return reply.code(404).send({ error: 'Not found' });
    return reply.send({ job });
  });

  // GET /operator/approvals?status=pending — UI polls this
  app.get('/operator/approvals', async (req, reply) => {
    const { userId } = getAuth(req);
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

    const { status = 'pending' } = req.query as { status?: string };
    const approvals = await prisma.operatorApproval.findMany({
      where: { status: status as any },
      include: {
        job: { select: { projectId: true, type: true, objective: true } },
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
    const approval = await prisma.operatorApproval.update({
      where: { id },
      data: { status: 'denied', resolvedBy: userId, resolvedAt: new Date() },
    });
    return reply.send({ approval });
  });
}
