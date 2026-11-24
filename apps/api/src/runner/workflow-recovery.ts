import { prisma } from '../prisma.js';
import { operatorQueue, enqueueOperatorJob } from './queue.js';

// Reconcile the database/queue dispatch boundary. Deterministic retained queue
// IDs prevent a second dispatch; node checkpoints handle resumed execution.
export async function recoverWorkflowDispatches() {
  const runs = await prisma.workflowRun.findMany({ where: { status: { in: ['queued', 'running'] }, operatorJobId: { not: null }, version: { is: { snapshotJson: { path: ['workflowType'], equals: 'graph' } } } }, take: 100, orderBy: { createdAt: 'asc' } });
  for (const run of runs) {
    const job = await operatorQueue.getJob(run.operatorJobId!);
    if (!job) await enqueueOperatorJob(run.operatorJobId!, { durable: true });
    else if (await job.getState() === 'failed') await job.retry();
  }
}
export function startWorkflowRecovery() {
  let busy = false;
  const recover = async () => {
    if (busy) return;
    busy = true;
    try { await recoverWorkflowDispatches(); } catch { console.error('[workflow] dispatch recovery failed; will retry'); } finally { busy = false; }
  };
  void recover();
  const timer = setInterval(recover, 15_000);
  timer.unref();
  return () => clearInterval(timer);
}
