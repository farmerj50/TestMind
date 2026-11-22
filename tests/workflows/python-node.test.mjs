import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as core from '../../packages/testmind-core/workflow/index.js';
import { pythonGraph, pythonNodeHarness } from './python-node-harness.mjs';
const require = createRequire(new URL('../../apps/api/package.json', import.meta.url));
const Fastify = require('fastify');
const fake = () => {
  let executions = 0, probes = 0;
  const h = pythonNodeHarness({ sandbox: { verifyPytestSandbox: async () => { probes++; return {}; } }, scriptAdapter: { executePythonScript: async context => {
    await context.authorize(); executions++;
    const evidence = { status: 'succeeded', counts: { total: 1, passed: 1, failed: 0, errors: 0, skipped: 0 } };
    return { outputs: { data: { answer: 4 }, result: { outcome: 'passed' } }, outcome: 'passed', evidence, branch: 'success' };
  } } });
  return Object.assign(h, { calls: () => ({ executions, probes }) });
};

test('Python node: schema, typed outputs and secret/path restrictions are registered', () => {
  const graph = pythonGraph();
  assert.equal(core.validateGraph(graph).valid, true);
  const definition = core.getNodeDefinition('python.script');
  assert.equal(definition.effect, 'idempotent');
  assert.equal(definition.automaticRecovery, false);
  assert.equal(definition.outputs.data, 'json');
  for (const mutate of [g => g.nodes[1].inputs.values = { kind: 'secret', key: 'private' },
    g => g.nodes[1].config.enabled = true, g => g.nodes[1].config.declarations.value.secret = true,
    g => g.nodes[1].config.declarations.value.path = '../host.txt', g => g.nodes[1].config.timeoutMs = 30001]) {
    const invalid = structuredClone(graph); mutate(invalid); assert.equal(core.validateGraph(invalid).valid, false);
  }
});
test('Python node: graph reporting includes evidence and repeated delivery does not execute twice', async () => {
  const h = fake(); assert.equal((await h.finish()).status, 'succeeded');
  assert.equal(h.rows.find(r => r.nodeKey === 'report').outputJson.outputs.result.outcome, 'passed');
  await h.tick(); assert.deepEqual(h.calls(), { executions: 1, probes: 1 });
});
test('Python node: disabled, invalid image, ownership, approval and environment deny execution', async () => {
  for (const deny of [h => delete h.env.TM_PYTHON_WORKFLOWS_ENABLED, h => h.env.TM_PYTHON_WORKFLOWS_ENABLED = 'true',
    h => h.env.TM_PYTHON_SANDBOX_IMAGE = 'python:latest', h => h.run.workflow.project.ownerId = 'foreign',
    h => h.run.approvedBy = null, h => h.environment.variables.changed = true]) {
    const h = fake(); deny(h); assert.equal((await h.finish()).status, 'failed'); assert.equal(h.calls().executions, 0);
  }
});
test('Python node: public task/version projections redact unbound project credentials and enforce ownership', async () => {
  const h = fake(); h.addSecret('custom-project-value-938');
  h.graph.nodes[1].inputs.values.value = { value: 'custom-project-value-938' };
  await h.finish();
  assert.equal(JSON.stringify(h.rows.map(row => [row.inputJson, row.outputJson, row.error])).includes('custom-project-value-938'), false);
  const app = Fastify(); await h.routes.workflowGraphRoutes(app);
  try {
    for (const url of ['/workflows/runs/run', '/workflows/workflow/versions']) {
      const owned = await app.inject({ url, headers: { 'x-user-id': 'owner' } });
      assert.equal(owned.statusCode, 200); assert.equal(owned.body.includes('custom-project-value-938'), false);
      assert.equal(owned.body.includes('stateEncrypted'), false);
      assert.equal((await app.inject({ url, headers: { 'x-user-id': 'foreign' } })).statusCode, 404);
    }
    assert.ok(h.secretScopes.every(where => where.projectId === 'project'));
    assert.ok(h.secretScopes.some(where => !where.key));
  } finally { await app.close(); }
});
test('Python node: unsafe retry outcomes and executed descendants remain blocked', async () => {
  for (const reason of ['unknown', 'descendants']) {
    const h = fake(); await h.finish(); h.run.status = 'failed';
    const python = h.rows.find(row => row.nodeKey === 'python'); python.status = 'failed';
    if (reason === 'unknown') { const state = JSON.parse(h.decode(python.stateEncrypted)); state.outcome = 'unknown'; python.stateEncrypted = Buffer.from(JSON.stringify(state)).toString('base64'); }
    const app = Fastify(); await h.routes.workflowGraphRoutes(app);
    try { assert.equal((await app.inject({ method: 'POST', url: '/workflows/runs/run/nodes/python/retry', headers: { 'x-user-id': 'owner' } })).statusCode, 409); }
    finally { await app.close(); }
    assert.equal(h.dispatches, 0);
  }
});
