import type { FastifyInstance } from 'fastify';
import { getAuth } from '@clerk/fastify';
import { NODE_DEFINITIONS, validateGraph, getNodeDefinition, canRetryNode, redactWorkflowValue, type WorkflowGraph } from '@testmind/core/workflow';
import { prisma } from '../prisma.js';
import { encryptSecret, decryptSecret } from '../lib/crypto.js';
import { environmentFingerprint } from '../lib/workflow-version.js';
import { operatorQueue, enqueueOperatorJob } from '../runner/queue.js';
import path from 'node:path';
import { REPORT_ROOT } from '../lib/storageRoots.js';
import { downloadableArtifact, artifactSecurityResponse } from '../lib/artifact-service.js';
import { publicArtifactReferences } from '../lib/artifact-references.js';

export async function workflowGraphRoutes(app: FastifyInstance) {
  const pythonSecrets = async (projectId: string, snapshots: any[]) => {
    if (!snapshots.some(snapshot => snapshot?.configJson?.graph?.nodes?.some((node: any) => node.type === 'python.script'))) return [];
    const rows = await prisma.projectSecret.findMany({ where: { projectId } });
    return rows.map(row => decryptSecret(row.value));
  };
  app.get('/workflows/artifacts/:id', async (req, reply) => {
    const userId = getAuth(req).userId;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });
    const artifact = await prisma.operatorArtifact.findFirst({ where: { id: (req.params as any).id, job: { project: { ownerId: userId } } }, include: { job: { select: { projectId: true } } } });
    if (!artifact?.testRunId) return reply.code(404).send({ error: 'Run evidence artifact not found' });
    const evidenceRun = await prisma.testRun.findFirst({ where: { id: artifact.testRunId, projectId: artifact.job.projectId, project: { ownerId: userId } }, select: { projectId: true } });
    if (!evidenceRun) return reply.code(404).send({ error: 'Run evidence artifact not found' });
    try {
      const artifactCopy = await downloadableArtifact({ root: path.join(REPORT_ROOT, 'runner-logs', artifact.testRunId), candidate: artifact.path, projectId: evidenceRun.projectId, runId: artifact.testRunId, trace: artifact.type === 'trace' });
      return reply.header('Cache-Control', 'private, no-store').header('Content-Disposition', `attachment; filename="${artifactCopy.sanitized ? 'sanitized-trace.zip' : 'evidence'}"`).header('X-Content-Type-Options', 'nosniff').type(artifactCopy.type).send(artifactCopy.data);
    } catch { return artifactSecurityResponse(reply); }
  });
  app.get('/workflows/:id/runs', async (req, reply) => {
    const userId = getAuth(req).userId;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });
    const workflowId = (req.params as any).id;
    const workflow = await prisma.workflow.findFirst({ where: { id: workflowId, project: { ownerId: userId } } });
    if (!workflow) return reply.code(404).send({ error: 'Workflow not found' });
    const before = (req.query as any)?.before;
    const runs = await prisma.workflowRun.findMany({ where: { workflowId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 25,
      ...(typeof before === 'string' ? { cursor: { id: before }, skip: 1 } : {}) });
    const jobs = await prisma.operatorJob.findMany({ where: { id: { in: runs.flatMap(run => run.operatorJobId ? [run.operatorJobId] : []) } }, select: { id: true, status: true, error: true } });
    return { runs: runs.map(run => ({ ...run, status: run.status === 'debug-completed' ? run.status : jobs.find(job => job.id === run.operatorJobId)?.status ?? run.status })), nextCursor: runs.length === 25 ? runs[runs.length - 1].id : null };
  });
  app.get('/workflows/node-registry', async (req, reply) => {
    if (!getAuth(req).userId) return reply.code(401).send({ error: 'Unauthorized' });
    return { schemaVersion: 1, nodes: NODE_DEFINITIONS };
  });
  app.post('/workflows/validate', async (req, reply) => {
    if (!getAuth(req).userId) return reply.code(401).send({ error: 'Unauthorized' });
    return validateGraph((req.body as any)?.graph);
  });
  app.get('/workflows/:id/versions', async (req, reply) => {
    const userId = getAuth(req).userId;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });
    const { id } = req.params as any;
    const workflow = await prisma.workflow.findFirst({ where: { id, project: { ownerId: userId } } });
    if (!workflow) return reply.code(404).send({ error: 'Workflow not found' });
    const versions = await prisma.workflowVersion.findMany({ where: { workflowId: id }, orderBy: { createdAt: 'desc' }, take: 100 });
    return redactWorkflowValue({ versions }, await pythonSecrets(workflow.projectId, versions.map(version => version.snapshotJson)));
  });
  const ownedRun = async (id: string, userId: string) => prisma.workflowRun.findFirst({ where: { id, workflow: { project: { ownerId: userId } } }, include: { version: true, workflow: true } });
  app.get('/workflows/runs/:id', async (req, reply) => {
    const userId = getAuth(req).userId;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });
    const run = await ownedRun((req.params as any).id, userId);
    if (!run) return reply.code(404).send({ error: 'Workflow run not found' });
    // Explicit projection: encrypted state and raw secret-bearing outputs never
    // leave the worker. Existing reporting links remain available by testRunId.
    const tasks = run.operatorJobId ? await prisma.operatorTask.findMany({ where: { jobId: run.operatorJobId }, select: {
      id: true, nodeKey: true, nodeVersion: true, nodeAttempt: true, status: true, inputJson: true, outputJson: true,
      error: true, testRunId: true, startedAt: true, finishedAt: true, artifacts: true,
    }, orderBy: { createdAt: 'asc' } }) : [];
    return redactWorkflowValue({ run, tasks: tasks.map(task => ({ ...task, artifacts: task.artifacts.map(({ path: _privatePath, ...artifact }) => ({ ...artifact, metaJson: publicArtifactReferences(artifact.metaJson), downloadUrl: `/workflows/artifacts/${artifact.id}` })) })) }, await pythonSecrets(run.workflow.projectId, [run.version?.snapshotJson]));
  });
  app.post('/workflows/runs/:id/cancel', async (req, reply) => {
    const userId = getAuth(req).userId;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });
    const run = await ownedRun((req.params as any).id, userId);
    if (!run) return reply.code(404).send({ error: 'Workflow run not found' });
    if (!['queued', 'running', 'blocked', 'awaiting_approval'].includes(run.status)) return reply.code(409).send({ error: 'Run is already resolved' });
    await prisma.$transaction(async tx => {
      await tx.workflowRun.update({ where: { id: run.id }, data: { status: 'canceled', finishedAt: new Date() } });
      if (run.operatorJobId) await tx.operatorJob.update({ where: { id: run.operatorJobId }, data: { status: 'canceled', finishedAt: new Date() } });
      const active = await tx.operatorTask.findMany({ where: { workflowRunId: run.id, status: { in: ['pending', 'running'] } } });
      for (const task of active) await tx.operatorTask.updateMany({ where: { id: task.id, status: { in: ['pending', 'running'] } }, data: { status: 'failed', finishedAt: new Date(), error: 'Workflow canceled', outputJson: { ...(task.outputJson as any), outcome: 'error', failureKind: 'canceled' } } });
    });
    return { status: 'canceled' };
  });
  app.post('/workflows/runs/:id/resume', async (req, reply) => {
    const userId = getAuth(req).userId;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });
    const run = await ownedRun((req.params as any).id, userId);
    if (!run) return reply.code(404).send({ error: 'Workflow run not found' });
    if (!run.operatorJobId || !['queued', 'running'].includes(run.status) || (run.version?.snapshotJson as any)?.workflowType !== 'graph') return reply.code(409).send({ error: 'Only an unfinished graph run can resume' });
    const queued = await operatorQueue.getJob(run.operatorJobId);
    if (queued && await queued.getState() === 'failed') await queued.retry();
    else if (!queued) await enqueueOperatorJob(run.operatorJobId, { durable: true });
    return { status: 'queued' };
  });
  app.post('/workflows/runs/:id/nodes/:nodeId/retry', async (req, reply) => {
    const userId = getAuth(req).userId;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });
    const { id, nodeId } = req.params as any;
    const run = await ownedRun(id, userId);
    if (!run) return reply.code(404).send({ error: 'Workflow run not found' });
    if (run.status !== 'failed' || !run.version || !run.operatorJobId) return reply.code(409).send({ error: 'Run must be failed before retry' });
    const snapshot = run.version.snapshotJson as any;
    const graph = snapshot.configJson?.graph as WorkflowGraph;
    const node = graph?.nodes.find(n => n.id === nodeId);
    if (!node) return reply.code(404).send({ error: 'Node not found' });
    const tasks = await prisma.operatorTask.findMany({ where: { workflowRunId: id }, orderBy: { nodeAttempt: 'desc' } });
    const current = tasks.find(t => t.nodeKey === nodeId);
    const state = current?.stateEncrypted ? JSON.parse(decryptSecret(current.stateEncrypted)) : {};
    if (!current || state.outcome === 'unknown' || !canRetryNode(getNodeDefinition(node.type, node.version)!, current)) return reply.code(409).send({ error: 'This operation cannot be safely retried' });
    const descendants = new Set<string>();
    const visit = (source: string) => { for (const edge of graph.edges.filter(e => e.source === source)) if (!descendants.has(edge.target)) { descendants.add(edge.target); visit(edge.target); } };
    visit(nodeId);
    if (tasks.some(t => descendants.has(t.nodeKey!) && t.status !== 'skipped')) return reply.code(409).send({ error: 'Downstream nodes already executed; create a new run to verify the change' });
    if (Date.now() >= (run.startedAt ?? run.createdAt).getTime() + graph.limits.maxDurationMs || tasks.length >= graph.limits.maxNodeExecutions) return reply.code(409).send({ error: 'Execution limits exhausted; create a new run' });
    const environment = snapshot.environmentId ? await prisma.environment.findFirst({ where: { id: snapshot.environmentId, projectId: run.workflow.projectId } }) : null;
    if ((run.contextJson as any)?.environmentFingerprint !== environmentFingerprint(environment)) return reply.code(409).send({ error: 'Environment changed; create a new run' });
    await prisma.$transaction(async tx => {
      const claimed = await tx.workflowRun.updateMany({ where: { id, status: 'failed' }, data: { status: 'queued', finishedAt: null, error: null } });
      if (!claimed.count) throw Object.assign(new Error('Another request already resumed this run'), { statusCode: 409 });
      for (const task of tasks.filter(t => descendants.has(t.nodeKey!))) {
        const previous = task.stateEncrypted ? JSON.parse(decryptSecret(task.stateEncrypted)) : {};
        await tx.operatorTask.update({ where: { id: task.id }, data: { stateEncrypted: encryptSecret(JSON.stringify({ ...previous, superseded: true })), outputJson: { ...(task.outputJson as any), superseded: true } } });
      }
      await tx.operatorTask.create({ data: { jobId: run.operatorJobId!, workflowRunId: id, nodeKey: nodeId, nodeVersion: node.version, nodeAttempt: current.nodeAttempt + 1, type: 'execute', status: 'pending', stateEncrypted: encryptSecret(JSON.stringify({ activation: 'selected', deadline: Math.min((run.startedAt ?? run.createdAt).getTime() + graph.limits.maxDurationMs, Date.now() + getNodeDefinition(node.type)!.timeoutMs) })) } });
      await tx.operatorJob.update({ where: { id: run.operatorJobId! }, data: { status: 'queued', error: null, finishedAt: null } });
    });
    const queued = await operatorQueue.getJob(run.operatorJobId);
    if (queued && await queued.getState() === 'failed') await queued.retry();
    else if (!queued) await enqueueOperatorJob(run.operatorJobId, { durable: true });
    return { status: 'queued' };
  });
}
