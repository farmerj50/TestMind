import { prisma } from '../prisma.js';
import { environmentFingerprint } from './workflow-version.js';
import { allowsAutomaticRecovery } from '@testmind/core/workflow';

export async function authorizeWorkflowRepair(runId: string, projectId: string) {
  const child = await prisma.testRun.findFirst({ where: { id: runId, projectId }, select: { paramsJson: true } });
  const params = child?.paramsJson as any;
  const parentId = params?.workflowParentId ?? params?.workflowRunId;
  if (!parentId) return;
  const { snapshot } = await authorizedWorkflowContext(parentId, projectId);
  if (!allowsAutomaticRecovery(snapshot.configJson.graph.autonomy)) throw new Error('Automatic workflow repair is not authorized at this autonomy level');
}

// Claim before external effects. Queue retries or duplicate deliveries may inspect
// a child again, but must never re-enter its executor after it left queued.
export async function claimWorkflowChildRun(model: any, runId: string): Promise<boolean> {
  const claim = await model.updateMany({ where: { id: runId, status: 'queued' }, data: { status: 'running', startedAt: new Date() } });
  return claim.count === 1;
}

export function watchWorkflowExecution(runId: string, projectId: string) {
  const controller = new AbortController();
  let checking = false;
  const timer = setInterval(async () => {
    if (checking || controller.signal.aborted) return;
    checking = true;
    try { await authorizedWorkflowContext(runId, projectId); }
    catch (error) { controller.abort(error); }
    finally { checking = false; }
  }, 250);
  timer.unref();
  return { signal: controller.signal, stop: () => clearInterval(timer) };
}

export async function authorizedWorkflowContext(runId: string, projectId: string) {
  const run = await prisma.workflowRun.findUnique({ where: { id: runId }, include: { version: true, workflow: { include: { project: true } } } });
  if (!run || run.workflow.projectId !== projectId || run.requestedBy !== run.workflow.project.ownerId || !['queued', 'running'].includes(run.status)) throw new Error('Workflow execution is no longer authorized');
  const snapshot = run.version?.snapshotJson as any;
  if (!snapshot?.configJson?.graph) throw new Error('Workflow graph version is unavailable');
  if (Date.now() >= (run.startedAt ?? run.createdAt).getTime() + snapshot.configJson.graph.limits.maxDurationMs) throw new Error('Workflow duration limit exceeded');
  const environment = snapshot.environmentId ? await prisma.environment.findFirst({ where: { id: snapshot.environmentId, projectId } }) : null;
  if ((snapshot.environmentId && !environment) || (run.contextJson as any)?.environmentFingerprint !== environmentFingerprint(environment)) throw new Error('Workflow environment changed');
  if ((snapshot.approvalRequired || run.workflow.approvalRequired || environment?.requiresApproval || environment?.isProtected) && run.approvedBy !== run.workflow.project.ownerId) throw new Error('Workflow requires approval');
  return { run, snapshot, environment };
}
