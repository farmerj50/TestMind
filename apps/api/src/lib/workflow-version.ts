import { createHash } from 'node:crypto';
import { validateGraph, type WorkflowGraph } from '@testmind/core/workflow';
import { prisma } from '../prisma.js';

function canonical(value: any): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export const workflowDigest = (value: any) => createHash('sha256').update(canonical(value)).digest('hex');
export function workflowSnapshot(workflow: any) {
  return { name: workflow.name, workflowType: workflow.workflowType, triggerType: workflow.triggerType,
    environmentId: workflow.environmentId ?? null, suiteId: workflow.suiteId ?? null,
    approvalRequired: workflow.approvalRequired, notifyOnFailure: workflow.notifyOnFailure,
    configJson: workflow.configJson ?? {} };
}
export async function saveWorkflowVersion(workflow: any, userId: string, db: any = prisma) {
  const snapshot = workflowSnapshot(workflow);
  const digest = workflowDigest(snapshot);
  return db.workflowVersion.upsert({ where: { workflowId_digest: { workflowId: workflow.id, digest } },
    create: { workflowId: workflow.id, digest, snapshotJson: snapshot, createdBy: userId }, update: {} });
}
export function getWorkflowGraph(workflow: any): WorkflowGraph | null {
  return workflow.configJson?.graph ?? null;
}
export function workflowGraphErrors(workflow: any) {
  const graph = getWorkflowGraph(workflow);
  if (workflow.workflowType === 'graph' && !graph) return [{ code: 'graph', message: 'Graph workflows require a graph.' }];
  if (graph && workflow.workflowType !== 'graph') return [{ code: 'graph', message: 'A graph requires workflowType graph.' }];
  return graph ? validateGraph(graph).errors : [];
}
export function environmentFingerprint(environment: any) {
  return workflowDigest(environment ? { id: environment.id, baseUrl: environment.baseUrl, variables: environment.variables ?? {},
    requiresApproval: environment.requiresApproval, isProtected: environment.isProtected } : null);
}
