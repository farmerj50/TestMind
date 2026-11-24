import { getNodeDefinition, redactWorkflowValue, type WorkflowGraph } from '@testmind/core/workflow';
import { prisma } from '../prisma.js';
import { encryptSecret, decryptSecret } from '../lib/crypto.js';
import { environmentFingerprint } from '../lib/workflow-version.js';
import { advanceWorkflow, type GraphTask } from './workflow-engine.js';
import { executeWorkflowHandler } from './workflow-handlers.js';

const permissions = ['project:read', 'results:read', 'tests:write', 'network:access', 'api:execute', 'ui:execute', 'workflow:execute'];
export async function runWorkflowGraph(job: { id: string; projectId: string; requestedBy: string | null; contextJson: unknown }) {
  const runId = (job.contextJson as any)?.workflowRunId;
  const run = await prisma.workflowRun.findUnique({ where: { id: runId }, include: { version: true, workflow: { include: { project: true } } } });
  if (!run || run.operatorJobId !== job.id || run.workflow.projectId !== job.projectId || !run.version) throw new Error('Workflow execution provenance is invalid');
  if (['succeeded', 'failed', 'canceled', 'denied'].includes(run.status)) return { status: run.status };
  const snapshot = run.version.snapshotJson as any;
  const graph = snapshot.configJson.graph as WorkflowGraph;
  const environment = snapshot.environmentId ? await prisma.environment.findFirst({ where: { id: snapshot.environmentId, projectId: job.projectId } }) : null;
  const context = run.contextJson as any;
  let sourceOutputs = {};
  if (context?.sourceRunId) {
    const source = await prisma.workflowRun.findFirst({ where: { id: context.sourceRunId, workflowId: run.workflowId, versionId: run.versionId, requestedBy: run.requestedBy, status: { in: ['succeeded', 'failed', 'debug-completed'] } } });
    if (!source || (source.contextJson as any)?.environmentFingerprint !== context.environmentFingerprint) throw new Error('Debug source version or environment is no longer valid');
    const tasks = await prisma.operatorTask.findMany({ where: { workflowRunId: source.id }, orderBy: { nodeAttempt: 'asc' } });
    sourceOutputs = Object.fromEntries(tasks.map(task => {
      const state = task.stateEncrypted ? JSON.parse(decryptSecret(task.stateEncrypted)) : {};
      return [task.nodeKey!, state.superseded ? undefined : state.outputs];
    }));
  }
  const keys = [...new Set(graph.nodes.flatMap(node => Object.values(node.inputs).filter(binding => binding.kind === 'secret').map(binding => (binding as any).key)))];
  // Python constants may accidentally contain an unbound project credential.
  // Scrub every project secret before persisting public task inputs, even if the
  // adapter later rejects those inputs. Other workflows retain existing loading.
  const hasPython = graph.nodes.some(node => node.type === 'python.script');
  const secretRows = hasPython || keys.length ? await prisma.projectSecret.findMany({ where: { projectId: job.projectId, ...(hasPython ? {} : { key: { in: keys } }) } }) : [];
  const secrets = Object.fromEntries(secretRows.map(secret => [secret.key, decryptSecret(secret.value)]));
  const scrub = (value: any, task?: GraphTask) => redactWorkflowValue(value, [...Object.values(secrets), ...Object.entries(task?.state.inputs ?? {}).filter(([key]) => getNodeDefinition(graph.nodes.find(node => node.id === task?.nodeKey)?.type ?? '')?.inputs[key]?.secret).map(([, value]) => String(value))]);
  const records = async (): Promise<GraphTask[]> => (await prisma.operatorTask.findMany({ where: { workflowRunId: runId }, orderBy: { createdAt: 'asc' } })).map(task => ({ ...task, state: task.stateEncrypted ? JSON.parse(decryptSecret(task.stateEncrypted)) : {} })).filter(task => !task.state.superseded);
  const canceled = async () => {
    const [current, operator] = await Promise.all([prisma.workflowRun.findUnique({ where: { id: runId }, select: { status: true } }), prisma.operatorJob.findUnique({ where: { id: job.id }, select: { status: true } })]);
    return current?.status === 'canceled' || operator?.status === 'canceled';
  };
  const result = await advanceWorkflow(graph, {
    now: Date.now, startedAt: (run.startedAt ?? run.createdAt).getTime(), canceled, records,
    debugNodeId: context?.debugNodeId, sourceOutputs,
    executionCount: () => prisma.operatorTask.count({ where: { workflowRunId: runId } }),
    bindings: async () => ({ environment: { ...(environment?.variables as any ?? {}), ...(environment?.baseUrl ? { baseUrl: environment.baseUrl } : {}) }, secrets }),
    authorize: async () => ({ projectOwned: run.workflow.project.ownerId === job.requestedBy,
      permissions, environmentAllowed: (!snapshot.environmentId || !!environment) && context?.environmentFingerprint === environmentFingerprint(environment),
      approvalRequired: !!(snapshot.approvalRequired || run.workflow.approvalRequired || environment?.requiresApproval || environment?.isProtected),
      approvalGranted: run.approvedBy === run.workflow.project.ownerId, withinLimits: Date.now() < (run.startedAt ?? run.createdAt).getTime() + graph.limits.maxDurationMs }),
    create: async (node, state, status) => {
      const previous = await prisma.operatorTask.findFirst({ where: { workflowRunId: runId, nodeKey: node.id }, orderBy: { nodeAttempt: 'desc' } });
      const row = await prisma.operatorTask.create({ data: { jobId: job.id, workflowRunId: runId, nodeKey: node.id, nodeVersion: node.version, nodeAttempt: (previous?.nodeAttempt ?? 0) + 1, type: 'execute', status: status as any,
        startedAt: new Date(), ...(status === 'skipped' ? { finishedAt: new Date() } : {}), stateEncrypted: encryptSecret(JSON.stringify(state)),
        inputJson: scrub(state.inputs ?? {}), outputJson: scrub({ activation: state.activation }) } });
      return { ...row, state };
    },
    save: async (task, status, state, error) => {
      await prisma.operatorTask.update({ where: { id: task.id }, data: { status: status as any, stateEncrypted: encryptSecret(JSON.stringify(state)),
        inputJson: scrub(state.inputs ?? {}, { ...task, state }), outputJson: scrub({ branch: state.branch, activation: state.activation, outcome: state.outcome, failureKind: state.failureKind, outputs: state.outputs, evidence: state.evidence }, { ...task, state }),
        error: error ? scrub(error, { ...task, state }) : null, ...(status !== 'running' ? { finishedAt: new Date() } : {}) } });
    },
    execute: (node, inputs, task, checkpoint, signal) => executeWorkflowHandler({ node, inputs, task, checkpoint, run, snapshot, environment, graph, canceled, signal, secretValues: Object.values(secrets) }),
  });
  if (result.status !== 'pending') await prisma.workflowRun.updateMany({ where: { id: runId, status: { not: 'canceled' } }, data: { status: result.status, finishedAt: new Date(), error: result.error ? scrub(result.error) : null } });
  else await prisma.workflowRun.updateMany({ where: { id: runId, status: 'queued' }, data: { status: 'running' } });
  return result;
}
