// Real graph runner, handlers, server policy and routes; only persistence/queue/auth adapters are isolated.
import crypto from 'node:crypto';
import * as core from '../../packages/testmind-core/workflow/index.js';
import { loadTs } from './operator-harness.mjs';

export const node = (id, type, config = {}, inputs = {}) => ({ id, type, version: 1, required: true, position: { x: 0, y: 0 }, config, inputs });
export function pythonGraph(script = 'def main(inputs):\n    return {"answer": inputs["value"] + 1}\n', timeoutMs = 10000) {
  return { schemaVersion: 1, autonomy: 'assisted', variables: {}, limits: { maxDurationMs: 120000, maxNodeExecutions: 20, maxConcurrency: 1 },
    nodes: [node('start', 'start'), node('python', 'python.script', { script, timeoutMs, declarations: { value: { type: 'number', required: true } } },
      { values: { kind: 'constant', value: { value: 3 } } }), node('check', 'assert', { checks: [{ id: 'answer', operator: 'equals', path: 'answer', expected: 4 }] },
      { actual: { kind: 'output', nodeId: 'python', port: 'data' } }), node('report', 'report'), node('end', 'end')],
    edges: ['start', 'python', 'check', 'report'].map((source, index) => ({ id: `e${index}`, source, target: ['python', 'check', 'report', 'end'][index], branch: 'success' })) };
}

export function pythonNodeHarness({ sandbox, scriptAdapter, graph = pythonGraph(), imageId = `sha256:${'a'.repeat(64)}` }) {
  const rows = [], secrets = [], secretScopes = [];
  const environment = { id: 'env', baseUrl: 'https://controlled.invalid', variables: {}, requiresApproval: true, isProtected: true };
  const env = { TM_PYTHON_WORKFLOWS_ENABLED: '1', TM_PYTHON_SANDBOX_IMAGE: imageId };
  const encode = value => Buffer.from(value).toString('base64');
  const decode = value => Buffer.from(value, 'base64').toString();
  const snapshot = { environmentId: environment.id, approvalRequired: true, configJson: { graph }, workflowType: 'graph' };
  const run = { id: 'run', workflowId: 'workflow', versionId: 'version', operatorJobId: 'job', requestedBy: 'owner', approvedBy: 'owner', status: 'queued',
    createdAt: new Date(), startedAt: new Date(), contextJson: {}, version: { id: 'version', snapshotJson: snapshot },
    workflow: { id: 'workflow', projectId: 'project', project: { id: 'project', ownerId: 'owner' }, approvalRequired: true, configJson: { graph } } };
  const operator = { id: 'job', status: 'queued' };
  let dispatches = 0;
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
    projectSecret: { findMany: async ({ where }) => { secretScopes.push(clone(where)); return where.projectId === 'project' ? secrets.filter(s => !where.key || where.key.in.includes(s.key)).map(clone) : []; } },
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
    $transaction: async callback => callback(prisma),
  };
  const version = loadTs('apps/api/src/lib/workflow-version.ts', { 'node:crypto': crypto, '@testmind/core/workflow': core, '../prisma.js': { prisma } });
  run.contextJson.environmentFingerprint = version.environmentFingerprint(environment);
  const policy = loadTs('apps/api/src/lib/workflow-execution-policy.ts', { '../prisma.js': { prisma }, './workflow-version.js': version, '@testmind/core/workflow': core });
  const python = loadTs('apps/api/src/runner/python-node.ts', { '../lib/workflow-execution-policy.js': policy, './pytest-sandbox.js': sandbox, './python-script.js': scriptAdapter }, { process: { env } });
  const handler = loadTs('apps/api/src/runner/workflow-handlers.ts', {
    'node:fs/promises': {}, '@testmind/core/workflow': core, '../prisma.js': { prisma }, './queue.js': {},
    '../lib/workflow-http.js': {}, '../security/openapi-parser.js': {}, '../testmind/discover.js': {},
    '../testmind/pipeline/generate-plan.js': {}, '../testmind/pipeline/codegen.js': {}, '../lib/storageRoots.js': {},
    '../lib/application-brain-query.js': {}, '../lib/workflow-risk.js': {}, '../lib/workflow-evidence.js': {}, './workflow-evidence-collector.js': {}, './python-node.js': python,
  });
  const controls = loadTs('apps/api/src/runner/workflow-controls.ts', { '@testmind/core/workflow': core });
  const engine = loadTs('apps/api/src/runner/workflow-engine.ts', { '@testmind/core/workflow': core, './workflow-controls.js': controls });
  const cryptoAdapter = { encryptSecret: encode, decryptSecret: decode };
  const runner = loadTs('apps/api/src/runner/workflow-runner.ts', { '@testmind/core/workflow': core, '../prisma.js': { prisma },
    '../lib/crypto.js': cryptoAdapter, '../lib/workflow-version.js': version, './workflow-engine.js': engine, './workflow-handlers.js': handler });
  const routes = loadTs('apps/api/src/routes/workflowGraphs.ts', { '@clerk/fastify': { getAuth: req => ({ userId: req.headers['x-user-id'] }) },
    '@testmind/core/workflow': core, '../prisma.js': { prisma }, '../lib/crypto.js': cryptoAdapter, '../lib/workflow-version.js': version,
    '../runner/queue.js': { operatorQueue: { getJob: async () => null }, enqueueOperatorJob: async () => dispatches++ },
    '../lib/storageRoots.js': { REPORT_ROOT: '' }, '../lib/artifact-service.js': {}, '../lib/artifact-references.js': { publicArtifactReferences: value => value },
  });
  const tick = () => runner.runWorkflowGraph({ id: 'job', projectId: 'project', requestedBy: 'owner', contextJson: { workflowRunId: 'run' } });
  return { graph, run, env, rows, environment, routes, tick, secretScopes, decode, get dispatches() { return dispatches; },
    addSecret(value) { secrets.push({ key: 'private', value: encode(value) }); },
    async finish() { for (let i = 0; i < 15; i++) { const result = await tick(); if (result.status !== 'pending') return result; } throw new Error('Graph fixture stalled'); },
  };
}
