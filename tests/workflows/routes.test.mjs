import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import * as core from '../../packages/testmind-core/workflow/index.js';
import { loadTs } from './operator-harness.mjs';
const versions = loadTs('apps/api/src/lib/workflow-version.ts', { 'node:crypto': crypto, '@testmind/core/workflow': core, '../prisma.js': { prisma: {} } });

test('immutable version digest ignores object key order and changes with graph behavior', () => {
  assert.equal(versions.workflowDigest({ a: 1, b: 2 }), versions.workflowDigest({ b: 2, a: 1 }));
  assert.notEqual(versions.workflowDigest({ graph: { autonomy: 'assisted' } }), versions.workflowDigest({ graph: { autonomy: 'autonomous-recovery' } }));
});
test('environment changes invalidate approval-bound execution state', () => {
  const env = { id: 'env-1', baseUrl: 'https://staging.example', variables: { account: 'test' }, requiresApproval: true, isProtected: true };
  for (const patch of [{ baseUrl: 'https://production.example' }, { variables: { account: 'other' } }, { requiresApproval: false }]) assert.notEqual(versions.environmentFingerprint(env), versions.environmentFingerprint({ ...env, ...patch }));
});
async function routeHarness(prisma = {}) {
  const routes = new Map(); const queued = [];
  const module = loadTs('apps/api/src/routes/workflowGraphs.ts', {
    '@clerk/fastify': { getAuth: req => ({ userId: req.userId }) }, '@testmind/core/workflow': core,
    '../prisma.js': { prisma }, '../lib/crypto.js': { encryptSecret: value => value, decryptSecret: value => value },
    '../lib/workflow-version.js': versions, '../runner/queue.js': { operatorQueue: { getJob: async () => null }, enqueueOperatorJob: async id => queued.push(id) },
    'node:fs/promises': {}, '../lib/storageRoots.js': { REPORT_ROOT: 'virtual-reports' },
    '../lib/artifact-service.js': {},
    '../lib/artifact-references.js': {},
  });
  await module.workflowGraphRoutes({ get: (url, handler) => routes.set(`GET ${url}`, handler), post: (url, handler) => routes.set(`POST ${url}`, handler) });
  return { queued, async call(method, url, request = {}) { const response = { status: 200, body: undefined }; const reply = { code(status) { response.status = status; return this; }, send(body) { response.body = body; return this; } }; const returned = await routes.get(`${method} ${url}`)({ userId: 'owner', params: {}, ...request }, reply); return { ...response, body: response.body ?? returned }; } };
}
test('every graph API rejects anonymous access before reading execution data', async () => {
  const h = await routeHarness();
  for (const [method, url] of [['GET', '/workflows/node-registry'], ['POST', '/workflows/validate'], ['GET', '/workflows/:id/versions'], ['GET', '/workflows/:id/runs'], ['GET', '/workflows/runs/:id'], ['POST', '/workflows/runs/:id/cancel'], ['POST', '/workflows/runs/:id/resume'], ['POST', '/workflows/runs/:id/nodes/:nodeId/retry'], ['GET', '/workflows/artifacts/:id']]) assert.equal((await h.call(method, url, { userId: null })).status, 401);
});
test('run inspection and cancellation scope lookup to the authenticated project owner', async () => {
  const queries = [];
  const h = await routeHarness({ workflowRun: { findFirst: async query => { queries.push(query); return null; } } });
  for (const [method, url] of [['GET', '/workflows/runs/:id'], ['POST', '/workflows/runs/:id/cancel']]) assert.equal((await h.call(method, url, { params: { id: 'foreign' } })).status, 404);
  for (const query of queries) { assert.equal(query.where.id, 'foreign'); assert.equal(query.where.workflow.project.ownerId, 'owner'); }
});
test('artifact access checks project ownership before reading a local file', async () => {
  let query;
  const h = await routeHarness({ operatorArtifact: { findFirst: async value => { query = value; return null; } } });
  assert.equal((await h.call('GET', '/workflows/artifacts/:id', { params: { id: 'secret-file' } })).status, 404);
  assert.equal(query.where.job.project.ownerId, 'owner');
});
test('inspection explicitly excludes private encrypted execution state', async () => {
  let query;
  // ownedRun() includes the workflow relation; the route reads run.workflow.projectId for redaction scope.
  const h = await routeHarness({ workflowRun: { findFirst: async () => ({ id: 'run', operatorJobId: 'job', workflow: { id: 'workflow', projectId: 'project' }, version: null }) }, operatorTask: { findMany: async value => { query = value; return []; } } });
  assert.equal((await h.call('GET', '/workflows/runs/:id', { params: { id: 'run' } })).status, 200);
  assert.equal(query.select.stateEncrypted, undefined); assert.equal(query.select.inputJson, true); assert.equal(query.select.outputJson, true);
});
test('resume cannot bypass awaiting approvals or replay successful runs', async () => {
  for (const status of ['awaiting_approval', 'denied', 'succeeded', 'canceled']) {
    const h = await routeHarness({ workflowRun: { findFirst: async () => ({ id: 'run', status, operatorJobId: 'job', version: { snapshotJson: { workflowType: 'graph' } } }) } });
    assert.equal((await h.call('POST', '/workflows/runs/:id/resume', { params: { id: 'run' } })).status, 409); assert.equal(h.queued.length, 0);
  }
});
test('failed external writes cannot be retried through the node debugger', async () => {
  const h = await routeHarness({ workflowRun: { findFirst: async () => ({ id: 'run', status: 'failed', operatorJobId: 'job', version: { snapshotJson: { configJson: { graph: { nodes: [{ id: 'write', type: 'api.request', version: 1 }] } } } } }) }, operatorTask: { findMany: async () => [{ nodeKey: 'write', status: 'failed', nodeAttempt: 1, stateEncrypted: JSON.stringify({ outcome: 'error' }) }] } });
  assert.equal((await h.call('POST', '/workflows/runs/:id/nodes/:nodeId/retry', { params: { id: 'run', nodeId: 'write' } })).status, 409); assert.equal(h.queued.length, 0);
});
