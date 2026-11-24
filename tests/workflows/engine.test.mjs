import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../../packages/testmind-core/workflow/index.js';
import { loadTs } from './operator-harness.mjs';

const controls = loadTs('apps/api/src/runner/workflow-controls.ts', { '@testmind/core/workflow': core });
const engine = loadTs('apps/api/src/runner/workflow-engine.ts', { '@testmind/core/workflow': core, './workflow-controls.js': controls });
const node = (id, type, extra = {}) => ({ id, type, version: 1, required: true, position: { x: 0, y: 0 }, config: {}, inputs: {}, ...extra });
const edge = (source, target, branch = 'success') => ({ id: `${source}-${target}-${branch}`, source, target, branch });
function fixture(middle = node('check', 'assert', { config: { checks: [{ id: 'correct', operator: 'equals', expected: 200 }] }, inputs: { actual: { kind: 'constant', value: 200 } } })) {
  const graph = { schemaVersion: 1, autonomy: 'assisted', variables: {}, limits: { maxDurationMs: 60000, maxNodeExecutions: 10, maxConcurrency: 1 }, nodes: [node('start', 'start'), middle, node('end', 'end')], edges: [edge('start', middle.id), edge(middle.id, 'end')] };
  const rows = []; let clock = 1, canceled = false, executions = 0;
  const runtime = {
    now: () => clock, startedAt: 1, canceled: async () => canceled, records: async () => structuredClone(rows),
    create: async (node, state, status) => { const row = { id: String(rows.length + 1), nodeKey: node.id, nodeAttempt: 1, status, state: structuredClone(state) }; rows.push(row); return structuredClone(row); },
    save: async (task, status, state, error) => { Object.assign(rows.find(r => r.id === task.id), { status, state: structuredClone(state), error }); },
    authorize: async () => ({ projectOwned: true, permissions: core.NODE_DEFINITIONS.flatMap(n => n.permissions), environmentAllowed: true, approvalRequired: false, approvalGranted: false, withinLimits: true }),
    bindings: async () => ({ environment: {}, secrets: {} }),
    execute: async () => { executions++; return { outputs: { response: { status: 200, headers: {}, body: {}, durationMs: 1 } }, branch: 'success' }; },
  };
  return { graph, runtime, rows, setClock: v => clock = v, cancel: () => canceled = true, get executions() { return executions; }, tick: () => engine.advanceWorkflow(graph, runtime), async finish() { let result; for (let i = 0; i < 20; i++) { result = await this.tick(); if (result.status !== 'pending') return result; } throw new Error('stalled fixture'); } };
}

test('persisted graph executes once and derives success from assertion evidence', async () => {
  const h = fixture(); assert.equal((await h.finish()).status, 'succeeded');
  assert.equal(h.rows.length, 3); assert.equal((await h.tick()).status, 'succeeded'); assert.equal(h.rows.length, 3);
});
test('failed assertions remain failed even with a selected failure branch to End', async () => {
  const h = fixture(); h.graph.nodes[1].inputs.actual.value = 500; h.graph.edges[1].branch = 'failure';
  const result = await h.finish(); assert.equal(result.status, 'failed'); assert.match(result.error, /failed/);
  assert.equal(h.rows.find(r => r.nodeKey === 'end').status, 'succeeded');
});
test('a graph containing no testing evidence cannot report QA success', async () => {
  const h = fixture(node('merge', 'merge', { config: { mode: 'all-active' } }));
  assert.equal((await h.finish()).status, 'failed');
});
test('nonselected branch is explicitly skipped and merge executes once', async () => {
  const h = fixture();
  h.graph.nodes.splice(1, 0, node('branch', 'condition', { config: { operator: 'exists' }, inputs: { left: { kind: 'constant', value: 1 } } }), node('other', 'assert', { config: { checks: [{ id: 'bad', operator: 'equals', expected: 0 }] }, inputs: { actual: { kind: 'constant', value: 1 } } }), node('merge', 'merge', { config: { mode: 'all-active' } }));
  h.graph.edges = [edge('start', 'branch'), edge('branch', 'check', 'true'), edge('branch', 'other', 'false'), edge('check', 'merge'), edge('other', 'merge'), edge('merge', 'end')];
  assert.equal((await h.finish()).status, 'succeeded');
  assert.equal(h.rows.find(r => r.nodeKey === 'other').status, 'skipped');
  assert.equal(h.rows.filter(r => r.nodeKey === 'merge').length, 1);
});
test('authorization is rechecked before each node and cannot be supplied in graph config', async () => {
  const h = fixture(); await h.tick(); h.runtime.authorize = async () => ({ projectOwned: false });
  assert.equal((await h.finish()).status, 'failed'); assert.equal(h.executions, 0);
});
test('cancellation and global timeout prevent new external work', async () => {
  const h = fixture(); h.cancel(); assert.equal((await h.tick()).status, 'canceled'); assert.equal(h.rows.length, 0);
  const t = fixture(); t.setClock(60001); assert.equal((await t.tick()).status, 'failed'); assert.equal(t.rows.length, 0);
});
const request = () => node('request', 'api.request', { config: { method: 'POST' }, inputs: { url: { kind: 'constant', value: 'https://example.test' } } });
test('restart after an ambiguous write does not send it twice', async () => {
  const h = fixture(request()); await h.tick();
  const save = h.runtime.save;
  h.runtime.save = async (task, status, state, error) => { if (state.phase === 'finished') throw new Error('simulated database outage'); return save(task, status, state, error); };
  await assert.rejects(h.tick(), /outage/); assert.equal(h.executions, 1);
  h.runtime.save = save;
  assert.equal((await h.finish()).status, 'failed'); assert.equal(h.executions, 1);
  assert.equal(h.rows.find(r => r.nodeKey === 'request').state.outcome, 'unknown');
});
test('restart after completed write reuses saved outputs without repeating it', async () => {
  const h = fixture(request()); await h.tick(); await h.tick(); await h.finish(); assert.equal(h.executions, 1);
  await h.tick(); assert.equal(h.executions, 1);
});
test('durable child checkpoint survives polling and does not duplicate dispatch', async () => {
  const h = fixture(request()); let dispatched = 0;
  h.runtime.execute = async (_node, _inputs, task, checkpoint) => {
    if (!task.state.checkpoint) { dispatched++; await checkpoint({ childId: 'child-1' }); return { pending: true }; }
    assert.equal(task.state.checkpoint.childId, 'child-1');
    return { outputs: { response: { status: 200, headers: {}, body: {}, durationMs: 1 } } };
  };
  await h.finish(); assert.equal(dispatched, 1);
});
test('invalid handler outputs fail with infrastructure evidence', async () => {
  const h = fixture(request()); h.runtime.execute = async () => ({ outputs: { response: { status: '200' } } });
  assert.equal((await h.finish()).status, 'failed'); assert.match(h.rows.find(r => r.nodeKey === 'request').error, /invalid response/);
});
test('missing environment values fail without issuing requests', async () => {
  const h = fixture(request()); h.graph.nodes[1].inputs.url = { kind: 'environment', key: 'missing' };
  await h.finish(); assert.equal(h.executions, 0);
});

test('a failed newer attempt cannot expose an older attempt output to downstream nodes', async () => {
  const h = fixture(request());
  h.graph.nodes.splice(2, 0, node('check', 'assert', { config: { checks: [{ id: 'status', operator: 'exists' }] }, inputs: { actual: { kind: 'output', nodeId: 'request', port: 'response' } } }));
  h.graph.edges = [edge('start', 'request'), edge('request', 'check', 'failure'), edge('check', 'end')];
  h.rows.push({ id: 'start-task', nodeKey: 'start', nodeAttempt: 1, status: 'succeeded', state: { activation: 'selected', branch: 'success', outputs: {} } });
  h.rows.push({ id: 'new-attempt', nodeKey: 'request', nodeAttempt: 2, status: 'failed', state: { activation: 'selected', branch: 'failure', outcome: 'error' } });
  h.rows.push({ id: 'old-attempt', nodeKey: 'request', nodeAttempt: 1, status: 'failed', state: { activation: 'selected', branch: 'failure', outputs: { response: { status: 200 } } } });
  await h.tick();
  assert.equal(h.rows.find(row => row.nodeKey === 'check').status, 'failed');
  assert.equal(h.executions, 0);
});
test('structured assertions compare object contents and enforce nested JSON schema', () => {
  const n = node('check', 'assert', { config: { checks: [{ id: 'object', operator: 'equals', expected: { a: 1, b: 2 } }, { id: 'schema', operator: 'schema', schema: { type: 'object', properties: { a: { type: 'string' } } } }] } });
  const result = controls.executeControl(n, { actual: { b: 2, a: 1 } }, {});
  assert.equal(result.evidence.assertions[0].status, 'passed'); assert.equal(result.evidence.assertions[1].status, 'failed');
});
test('assertions cannot read prototype properties', () => {
  const n = node('check', 'assert', { config: { checks: [{ id: 'prototype', operator: 'exists', path: 'constructor' }] } });
  assert.equal(controls.executeControl(n, { actual: {} }, {}).outcome, 'failed');
});
test('redaction removes credentials from nested data and reflected responses', () => {
  const value = core.redactWorkflowValue({ headers: { Authorization: 'Bearer secret' }, body: { token: 'unknown', message: 'reflected secret' }, other: ['secret'] }, ['secret']);
  assert.deepEqual(value, { headers: { Authorization: '[redacted]' }, body: { token: '[redacted]', message: 'reflected [redacted]' }, other: ['[redacted]'] });
});

test('redaction covers header aliases, camel-case tokens, text logs and bearer reflections', () => {
  const value = core.redactWorkflowValue({ 'x-api-key': 'canary', accessToken: 'canary', refreshToken: 'canary', log: 'Authorization: Bearer canary; token=canary', reflected: 'canary' }, ['Bearer canary']);
  assert.equal(JSON.stringify(value).includes('canary'), false);
});

test('redacting persisted dates preserves timestamps for inspector durations and exports', () => {
  const date = new Date('2026-11-09T14:00:00.000Z');
  assert.deepEqual(core.redactWorkflowValue({ startedAt: date, tasks: [{ finishedAt: date, token: 'secret' }] }), { startedAt: date.toISOString(), tasks: [{ finishedAt: date.toISOString(), token: '[redacted]' }] });
});

test('canceling inline execution aborts its signal and records a canceled failure kind', async () => {
  const h = fixture(request()); await h.tick();
  let started;
  const ready = new Promise(resolve => started = resolve);
  h.runtime.execute = async (_node, _inputs, _task, _checkpoint, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true }); started();
  });
  const running = h.tick(); await ready; h.cancel();
  assert.equal((await running).status, 'canceled');
  assert.equal(h.rows.find(row => row.nodeKey === 'request').state.failureKind, 'canceled');
});

test('inline timeout remains distinct from assertion failure and infrastructure error', async () => {
  const h = fixture(request()); await h.tick();
  h.runtime.execute = async () => { const error = new Error('The operation timed out'); error.name = 'TimeoutError'; throw error; };
  await h.tick(); assert.equal(h.rows.find(row => row.nodeKey === 'request').state.failureKind, 'timeout');
});

test('individual-node diagnostics never claim complete workflow success', async () => {
  const h = fixture(); h.runtime.debugNodeId = 'check';
  assert.equal((await h.finish()).status, 'debug-completed');
  assert.equal(h.rows.length, 1); assert.equal(h.rows[0].nodeKey, 'check');
});
test('debugging requires valid resolved inputs before external execution', async () => {
  const h = fixture(request()); h.runtime.debugNodeId = 'request'; h.graph.nodes[1].inputs.url = { kind: 'environment', key: 'missing' };
  assert.equal((await h.finish()).status, 'failed'); assert.equal(h.executions, 0);
});
