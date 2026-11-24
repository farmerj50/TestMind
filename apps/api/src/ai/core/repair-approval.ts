import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { prisma } from '../../prisma.js';
import { authorizeWorkflowRepair } from '../../lib/workflow-execution-policy.js';
import type { AiExecutionContext } from './types.js';

// Bind approval to this exact attempt and source revision. A workflow-start
// approval is not an approval of a later proposed source change.
export async function approveRepairProposal(attemptId: string, context: AiExecutionContext, patchedSpec: string) {
  const task = await prisma.operatorTask.findFirst({ where: { type: 'repair', job: { projectId: context.scope.projectId }, inputJson: { path: ['healingAttemptId'], equals: attemptId } }, include: { job: { include: { project: true, environment: true } } } });
  if (!task) return; // Existing non-Operator repairs retain their authorization policy.
  const config = (task.job.contextJson ?? {}) as Record<string, any>;
  if (!config.repairApprovalRequired && !task.job.environment?.requiresApproval && !task.job.environment?.isProtected) return;
  const original = context.specContent ?? '', digest = (value: string) => createHash('sha256').update(value).digest('hex');
  await prisma.testHealingAttempt.update({ where: { id: attemptId }, data: { originalSpec: original, repairedSpec: patchedSpec, targetSpec: context.repoAbsolutePath, summary: 'Repair proposed; awaiting approval' } });
  const id = `repair-${attemptId}`;
  const approval = await prisma.operatorApproval.upsert({ where: { id }, create: { id, jobId: task.jobId, taskId: task.id, actionType: 'patch_code', requestedBy: task.job.project.ownerId, expiresAt: new Date(Date.now() + 120000), contextJson: { attemptId, originalDigest: digest(original), proposedDigest: digest(patchedSpec) } }, update: {} });
  const bound = approval.contextJson as any;
  if (bound?.originalDigest !== digest(original) || bound?.proposedDigest !== digest(patchedSpec)) throw new Error('Repair proposal changed; approval invalid');
  for (;;) {
    await authorizeWorkflowRepair(context.job.runId, context.scope.projectId);
    const current = await prisma.operatorApproval.findUniqueOrThrow({ where: { id }, include: { job: { include: { project: true } } } });
    if (current.job.status === 'canceled' || current.job.project.ownerId !== approval.requestedBy) throw new Error('Repair authorization changed');
    if (!current.expiresAt || current.expiresAt.getTime() <= Date.now()) {
      await prisma.operatorApproval.updateMany({ where: { id, status: 'pending' }, data: { status: 'expired' } });
      throw new Error('Repair approval expired');
    }
    if (current.status === 'denied' || current.status === 'expired') throw new Error('Repair was not approved');
    if (current.status === 'approved') {
      if (current.resolvedBy !== current.job.project.ownerId || digest(await fs.readFile(context.repoAbsolutePath, 'utf8')) !== digest(original)) throw new Error('Repair approval does not match current source or owner');
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}
