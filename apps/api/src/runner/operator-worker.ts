import { Worker, Job } from 'bullmq';
import { prisma } from '../prisma.js';
import { redis } from './redis.js';
import { enqueueRun } from './queue.js';
import type { OperatorJobPayload } from './queue.js';

/**
 * Operator worker — orchestrates OperatorJob lifecycle.
 *
 * Sprint 1 scope: qa job type only.
 * Creates an OperatorTask, enqueues a TestRun, links them,
 * and polls for completion. All execution logic stays in worker.ts.
 */
export const operatorWorker = new Worker(
  'operator-jobs',
  async (job: Job) => {
    const { operatorJobId } = job.data as OperatorJobPayload;

    const opJob = await prisma.operatorJob.findUnique({
      where: { id: operatorJobId },
      select: {
        id: true,
        projectId: true,
        type: true,
        status: true,
        contextJson: true,
        requestedBy: true,
      },
    });

    if (!opJob) throw new Error(`OperatorJob ${operatorJobId} not found`);
    if (opJob.status === 'canceled') return;

    await prisma.operatorJob.update({
      where: { id: operatorJobId },
      data: { status: 'running', startedAt: new Date() },
    });

    try {
      if (opJob.type === 'qa') {
        await runQaJob(opJob);
      } else {
        throw new Error(`OperatorJob type '${opJob.type}' not yet implemented`);
      }

      await prisma.operatorJob.update({
        where: { id: operatorJobId },
        data: { status: 'succeeded', finishedAt: new Date() },
      });
    } catch (err: any) {
      await prisma.operatorJob.update({
        where: { id: operatorJobId },
        data: {
          status: 'failed',
          finishedAt: new Date(),
          error: err?.message ?? String(err),
        },
      });
      throw err;
    }
  },
  { connection: redis }
);

async function runQaJob(opJob: {
  id: string;
  projectId: string;
  contextJson: unknown;
}) {
  const ctx = (opJob.contextJson ?? {}) as Record<string, any>;

  const task = await prisma.operatorTask.create({
    data: {
      jobId: opJob.id,
      type: 'execute',
      status: 'running',
      startedAt: new Date(),
      inputJson: ctx,
    },
  });

  const run = await prisma.testRun.create({
    data: {
      projectId: opJob.projectId,
      status: 'queued',
      trigger: 'operator',
      paramsJson: ctx,
    },
  });

  await prisma.operatorTask.update({
    where: { id: task.id },
    data: { testRunId: run.id },
  });

  await enqueueRun(run.id, {
    projectId: opJob.projectId,
    baseUrl: ctx.baseUrl,
    mode: ctx.mode ?? 'regular',
    file: ctx.file,
    grep: ctx.grep,
  });

  await waitForRun(run.id, task.id);
}

async function waitForRun(runId: string, taskId: string, timeoutMs = 10 * 60 * 1000) {
  const interval = 3000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const run = await prisma.testRun.findUnique({
      where: { id: runId },
      select: { status: true, error: true },
    });

    if (!run) break;

    if (run.status === 'succeeded' || run.status === 'failed') {
      await prisma.operatorTask.update({
        where: { id: taskId },
        data: {
          status: run.status === 'succeeded' ? 'succeeded' : 'failed',
          finishedAt: new Date(),
          error: run.error ?? null,
          outputJson: { testRunId: runId, finalStatus: run.status },
        },
      });
      return;
    }

    await new Promise((r) => setTimeout(r, interval));
  }

  await prisma.operatorTask.update({
    where: { id: taskId },
    data: {
      status: 'failed',
      finishedAt: new Date(),
      error: `Timed out waiting for TestRun ${runId}`,
    },
  });
  throw new Error(`waitForRun timeout for run ${runId}`);
}

operatorWorker.on('failed', (job, err) => {
  console.error(`[operator-worker] job ${job?.id} failed:`, err);
});

operatorWorker.on('completed', (job) => {
  console.log(`[operator-worker] job ${job?.id} completed`);
});
