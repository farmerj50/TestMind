// Real graph runner, engine and handlers for the eval.run node type; only persistence/queue
// adapters are mocked. Models the Phase 1 EvaluationRun as an async child job, the same way
// api.suite wraps ApiTestRun - enqueueEvaluationRun is recorded but never actually executed;
// tests drive the child to a terminal status directly, then tick() again to observe it.
import crypto from 'node:crypto';
import * as core from '../../packages/testmind-core/workflow/index.js';
import { loadTs } from './operator-harness.mjs';

export const node = (id, type, config = {}, inputs = {}) => ({ id, type, version: 1, required: true, position: { x: 0, y: 0 }, config, inputs });

export function evalGraph(evalInputs = {
  datasetId: { kind: 'constant', value: 'ds-1' },
  datasetVersion: { kind: 'constant', value: 'v1' },
  applicationId: { kind: 'constant', value: 'app-1' },
  applicationVersion: { kind: 'constant', value: 'v1' },
  cases: { kind: 'constant', value: [{ case_id: 'c1' }] },
}) {
  return {
    schemaVersion: 1, autonomy: 'assisted', variables: {}, limits: { maxDurationMs: 120000, maxNodeExecutions: 20, maxConcurrency: 1 },
    nodes: [
      node('start', 'start'),
      node('eval', 'eval.run', {}, evalInputs),
      node('report', 'report'),
      node('end', 'end'),
    ],
    edges: [
      { id: 'e0', source: 'start', target: 'eval', branch: 'success' },
      { id: 'e1', source: 'eval', target: 'report', branch: 'success' },
      { id: 'e2', source: 'eval', target: 'end', branch: 'failure' },
      { id: 'e3', source: 'report', target: 'end', branch: 'success' },
    ],
  };
}

// Phase 3: a graph whose eval.run node references a pinned dataset version instead of inline cases.
export function evalGraphWithDatasetVersion(datasetVersionId) {
  return evalGraph({
    datasetId: { kind: 'constant', value: 'ds-1' },
    datasetVersion: { kind: 'constant', value: 'v1' },
    applicationId: { kind: 'constant', value: 'app-1' },
    applicationVersion: { kind: 'constant', value: 'v1' },
    datasetVersionId: { kind: 'constant', value: datasetVersionId },
  });
}

export function evalNodeHarness({ graph = evalGraph(), datasetVersions = new Map() } = {}) {
  const rows = [];
  const evaluationRuns = new Map();
  const dispatchedRunIds = [];
  const environment = { id: 'env', baseUrl: 'https://controlled.invalid', variables: {}, requiresApproval: true, isProtected: true };
  const snapshot = { environmentId: environment.id, approvalRequired: true, configJson: { graph }, workflowType: 'graph' };
  const run = { id: 'run', workflowId: 'workflow', versionId: 'version', operatorJobId: 'job', requestedBy: 'owner', approvedBy: 'owner', status: 'queued',
    createdAt: new Date(), startedAt: new Date(), contextJson: {}, version: { id: 'version', snapshotJson: snapshot },
    workflow: { id: 'workflow', projectId: 'project', project: { id: 'project', ownerId: 'owner' }, approvalRequired: true, configJson: { graph } } };
  const operator = { id: 'job', status: 'queued' };
  const clone = value => structuredClone(value);
  const matches = (value, where = {}) => Object.entries(where).every(([key, condition]) => condition && typeof condition === 'object'
    ? ('in' in condition ? condition.in.includes(value[key]) : 'not' in condition ? value[key] !== condition.not : true)
    : value[key] === condition);
  const update = (value, where, data) => { if (!value || !matches(value, where)) return { count: 0 }; Object.assign(value, data); return { count: 1 }; };
  const prisma = {
    workflowRun: { findUnique: async () => clone(run), findFirst: async ({ where }) => where.workflow?.project?.ownerId === run.workflow.project.ownerId ? clone(run) : null,
      updateMany: async ({ where, data }) => update(run, where, data), update: async ({ data }) => { Object.assign(run, data); return clone(run); } },
    workflow: { findFirst: async ({ where }) => where.project?.ownerId === run.workflow.project.ownerId ? clone(run.workflow) : null },
    workflowVersion: { findMany: async () => [clone(run.version)] },
    environment: { findFirst: async ({ where }) => where.id === environment.id && where.projectId === 'project' ? clone(environment) : null },
    projectSecret: { findMany: async () => [] },
    operatorJob: { findUnique: async () => clone(operator), update: async ({ data }) => { Object.assign(operator, data); return clone(operator); } },
    operatorTask: {
      count: async () => rows.length,
      findFirst: async ({ where }) => clone(rows.filter(row => matches(row, where)).sort((a, b) => b.nodeAttempt - a.nodeAttempt)[0] ?? null),
      findMany: async ({ where, select, orderBy } = {}) => rows.filter(row => matches(row, where)).sort((a, b) => orderBy?.nodeAttempt === 'desc' ? b.nodeAttempt - a.nodeAttempt : 0)
        .map(row => select ? Object.fromEntries(Object.keys(select).map(key => [key, clone(row[key])])) : clone(row)),
      create: async ({ data }) => { const row = { id: `task-${rows.length + 1}`, artifacts: [], createdAt: new Date(), ...data }; rows.push(row); return clone(row); },
      update: async ({ where, data }) => { const row = rows.find(row => row.id === where.id); Object.assign(row, data); return clone(row); },
      updateMany: async ({ where, data }) => update(rows.find(row => row.id === where.id), where, data),
    },
    evaluationRun: {
      upsert: async ({ where, create }) => { if (!evaluationRuns.has(where.id)) evaluationRuns.set(where.id, { status: 'queued', overallGateStatus: null, ...clone(create) }); return clone(evaluationRuns.get(where.id)); },
      findUniqueOrThrow: async ({ where }) => { const row = evaluationRuns.get(where.id); if (!row) throw new Error('EvaluationRun not found'); return clone(row); },
      update: async ({ where, data }) => { Object.assign(evaluationRuns.get(where.id), data); return clone(evaluationRuns.get(where.id)); },
    },
    evaluationDatasetVersion: {
      findFirst: async ({ where }) => {
        const row = datasetVersions.get(where.id);
        // Ownership scoping mirrors the real handler's `dataset: { projectId }` filter.
        if (!row || where.dataset?.projectId !== 'project') return null;
        return clone(row);
      },
    },
    $transaction: async callback => callback(prisma),
  };
  const version = loadTs('apps/api/src/lib/workflow-version.ts', { 'node:crypto': crypto, '@testmind/core/workflow': core, '../prisma.js': { prisma } });
  run.contextJson.environmentFingerprint = version.environmentFingerprint(environment);
  const handler = loadTs('apps/api/src/runner/workflow-handlers.ts', {
    'node:fs/promises': {}, '@testmind/core/workflow': core, '../prisma.js': { prisma },
    './queue.js': { enqueueEvaluationRun: async ({ runId }) => { dispatchedRunIds.push(runId); } },
    '../lib/workflow-http.js': {}, '../security/openapi-parser.js': {}, '../testmind/discover.js': {},
    '../testmind/pipeline/generate-plan.js': {}, '../testmind/pipeline/codegen.js': {}, '../lib/storageRoots.js': {},
    '../lib/application-brain-query.js': {}, '../lib/workflow-risk.js': {}, '../lib/workflow-evidence.js': {}, './workflow-evidence-collector.js': {},
  });
  const controls = loadTs('apps/api/src/runner/workflow-controls.ts', { '@testmind/core/workflow': core });
  const engine = loadTs('apps/api/src/runner/workflow-engine.ts', { '@testmind/core/workflow': core, './workflow-controls.js': controls });
  const cryptoAdapter = { encryptSecret: v => v, decryptSecret: v => v };
  const runner = loadTs('apps/api/src/runner/workflow-runner.ts', { '@testmind/core/workflow': core, '../prisma.js': { prisma },
    '../lib/crypto.js': cryptoAdapter, '../lib/workflow-version.js': version, './workflow-engine.js': engine, './workflow-handlers.js': handler });
  const tick = () => runner.runWorkflowGraph({ id: 'job', projectId: 'project', requestedBy: 'owner', contextJson: { workflowRunId: 'run' } });
  return {
    graph, run, rows, evaluationRuns, dispatchedRunIds, tick,
    childId() { return [...evaluationRuns.keys()][0]; },
    async settleChild(status, overallGateStatus) { const id = this.childId(); if (id) Object.assign(evaluationRuns.get(id), { status, overallGateStatus }); },
    async finish() { for (let i = 0; i < 15; i++) { const result = await tick(); if (result.status !== 'pending') return result; } throw new Error('Graph fixture stalled'); },
    async until(predicate) { for (let i = 0; i < 15; i++) { if (predicate()) return; await tick(); } throw new Error('Condition never became true'); },
  };
}
