import test from 'node:test';
import assert from 'node:assert/strict';
import { validateGraph, validateValue, getNodeDefinition, AUTONOMY_LEVELS, checkNodeAuthorization, canRetryNode, assessTestEvidence, assessWorkflowEvidence } from '../../packages/testmind-core/workflow/index.js';

const node = (id, type, extra = {}) => ({ id, type, version: 1, config: {}, inputs: {}, position: { x: 0, y: 0 }, required: true, ...extra });
const edge = (source, target, branch = 'success') => ({ id: `${source}-${target}-${branch}`, source, target, branch });
export const basicGraph = () => ({ schemaVersion: 1, autonomy: 'assisted', limits: { maxDurationMs: 60000, maxNodeExecutions: 100, maxConcurrency: 1 }, variables: {}, nodes: [node('start', 'start'), node('check', 'assert', { config: { checks: [{ id: 'status', operator: 'equals', expected: 200 }] }, inputs: { actual: { kind: 'constant', value: 200 } } }), node('end', 'end')], edges: [edge('start', 'check'), edge('check', 'end')] });
const rejects = (mutate, code) => { const graph = basicGraph(); mutate(graph); const result = validateGraph(graph); assert.equal(result.valid, false); assert.ok(result.errors.some(error => error.code === code), JSON.stringify(result.errors)); };

test('versioned graph round trips positions, bindings and config', () => { const graph = basicGraph(); graph.nodes[1].position = { x: 124.5, y: -22 }; assert.equal(validateGraph(JSON.parse(JSON.stringify(graph))).valid, true); });
for (const [name, mutate, code] of [
  ['unknown schema version', g => g.schemaVersion = 2, 'schema'],
  ['unknown fields', g => g.executeCode = 'malicious', 'schema'],
  ['unsupported node version', g => g.nodes[1].version = 99, 'node-type'],
  ['duplicate nodes', g => g.nodes.push(g.nodes[1]), 'node-id'],
  ['missing start', g => g.nodes[0].type = 'end', 'start'],
  ['unbounded duration', g => g.limits.maxDurationMs = Number.MAX_SAFE_INTEGER, 'schema'],
  ['execution limit too small', g => g.limits.maxNodeExecutions = 1, 'limit'],
  ['invalid node config', g => g.nodes[1].config.checks = [], 'config'],
  ['missing assertion expectation', g => delete g.nodes[1].config.checks[0].expected, 'assertion'],
  ['invalid assertion schema', g => g.nodes[1].config.checks = [{ id: 'schema', operator: 'schema', schema: { type: 'invalid' } }], 'assertion'],
  ['missing required input', g => g.nodes[1].inputs = {}, 'input-required'],
  ['unknown input', g => g.nodes[1].inputs.extra = { kind: 'constant', value: 1 }, 'input'],
  ['secrets in unapproved ports', g => g.nodes[1].inputs.actual = { kind: 'secret', key: 'TOKEN' }, 'secret-binding'],
  ['missing variable', g => g.nodes[1].inputs.actual = { kind: 'variable', key: 'unknown' }, 'variable'],
  ['invalid variable type', g => g.variables.count = { type: 'number', value: 'one' }, 'variable'],
  ['prototype binding', g => g.nodes[1].inputs.actual = { kind: 'variable', key: 'constructor' }, 'binding-key'],
  ['unknown endpoint', g => g.edges[0].target = 'missing', 'edge-reference'],
  ['unsupported branch', g => g.edges[0].branch = 'true', 'edge-branch'],
  ['duplicate connection', g => g.edges.push({ ...g.edges[0], id: 'duplicate' }), 'edge-duplicate'],
  ['cycle', g => g.edges.push(edge('check', 'start')), 'cycle'],
  ['unreachable node', g => g.edges.shift(), 'unreachable'],
  ['unclosed path', g => g.edges.pop(), 'dead-end'],
  ['self data reference', g => g.nodes[1].inputs.actual = { kind: 'output', nodeId: 'check', port: 'result' }, 'output-order'],
  ['unknown output', g => g.nodes[1].inputs.actual = { kind: 'output', nodeId: 'start', port: 'constructor' }, 'output-type'],
]) test(`rejects ${name}`, () => rejects(mutate, code));

test('conditional output cannot escape through a merge where it may be absent', () => {
  const g = basicGraph();
  g.nodes.splice(1, 0, node('branch', 'condition', { config: { operator: 'exists' }, inputs: { left: { kind: 'constant', value: 1 } } }), node('merge', 'merge', { config: { mode: 'all-active' } }));
  g.edges = [edge('start', 'branch'), edge('branch', 'check', 'true'), edge('branch', 'merge', 'false'), edge('check', 'merge'), edge('merge', 'end')];
  assert.equal(validateGraph(g).valid, true);
  g.nodes.push(node('inspect', 'evidence.analyze', { inputs: { result: { kind: 'output', nodeId: 'check', port: 'result' } } }));
  g.edges.pop(); g.edges.push(edge('merge', 'inspect'), edge('inspect', 'end'));
  assert.ok(validateGraph(g).errors.some(e => e.code === 'output-order'));
});
test('typed bindings reject incompatible values and allow valid upstream references', () => {
  const g = basicGraph(); g.nodes[1] = node('check', 'api.request', { config: { method: 'GET' }, inputs: { url: { kind: 'constant', value: 12 } } });
  assert.ok(validateGraph(g).errors.some(e => e.code === 'input-type'));
  g.nodes[1].inputs.url.value = 'https://test.example'; assert.equal(validateGraph(g).valid, true);
  assert.equal(validateValue('http.response', { status: 200, headers: {}, body: {}, durationMs: 2 }), true);
  assert.equal(validateValue('http.response', { status: 200 }), false);
});
const authorization = () => ({ projectOwned: true, permissions: ['api:execute', 'network:access'], environmentAllowed: true, approvalRequired: true, approvalGranted: true, withinLimits: true });
for (const level of AUTONOMY_LEVELS) test(`${level} enforces ownership, permissions, environment, approval and limits`, () => {
  const definition = getNodeDefinition('api.request');
  assert.equal(checkNodeAuthorization(definition, level, authorization()).allowed, true);
  for (const key of ['projectOwned', 'environmentAllowed', 'approvalGranted', 'withinLimits']) assert.equal(checkNodeAuthorization(definition, level, { ...authorization(), [key]: false }).allowed, false);
  assert.equal(checkNodeAuthorization(definition, level, { ...authorization(), permissions: [] }).allowed, false);
});
test('unsafe retry never repeats a completed or ambiguous write', () => {
  const write = getNodeDefinition('api.request'), read = getNodeDefinition('risk.select');
  for (const status of ['succeeded', 'running', 'unknown']) assert.equal(canRetryNode(write, { status, externalIdempotencyConfirmed: true }), false);
  assert.equal(canRetryNode(write, { status: 'failed' }), false);
  assert.equal(canRetryNode(read, { status: 'failed' }), true);
});
const evidence = () => ({ status: 'succeeded', counts: { total: 1, passed: 1, failed: 0, errors: 0, skipped: 0 } });
test('quality gates require consistent nonempty passing evidence', () => {
  assert.equal(assessTestEvidence(evidence()).passed, true);
  for (const counts of [ { total: 0, passed: 0, failed: 0, errors: 0, skipped: 0 }, { total: 1, passed: 0, failed: 1, errors: 0, skipped: 0 }, { total: 1, passed: 0, failed: 0, errors: 1, skipped: 0 }, { total: 2, passed: 1, failed: 0, errors: 0, skipped: 1 }, { total: 2, passed: 1, failed: 0, errors: 0, skipped: 0 }, {} ]) assert.equal(assessTestEvidence({ ...evidence(), counts }).passed, false);
});
test('explicit expected skips require matching case evidence', () => {
  const e = { ...evidence(), counts: { ...evidence().counts, total: 2, skipped: 1 }, skippedIds: ['optional'], expectedSkippedIds: ['optional'] };
  assert.equal(assessTestEvidence(e).passed, true);
  assert.equal(assessTestEvidence({ ...e, skippedIds: ['unexpected'] }).passed, false);
});
test('required tests, assertions and verification phases cannot be overridden by success status', () => {
  for (const missing of [{ requiredCaseIds: ['required'] }, { assertions: [{ id: 'status', status: 'skipped' }] }, { verifications: [{ id: 'targeted', status: 'failed' }, { id: 'full', status: 'passed' }] }]) assert.equal(assessTestEvidence({ ...evidence(), ...missing }).passed, false);
});
test('workflow success requires all selected required nodes and testing evidence', () => {
  const check = { id: 'check', status: 'succeeded', testsRequired: true, evidence: evidence(), outcome: 'passed' };
  assert.equal(assessWorkflowEvidence([check]).passed, true);
  assert.equal(assessWorkflowEvidence([]).passed, false);
  assert.equal(assessWorkflowEvidence([check, { id: 'missing', status: 'skipped' }]).passed, false);
  assert.equal(assessWorkflowEvidence([check, { id: 'branch', status: 'skipped', activation: 'not-selected' }]).passed, true);
  assert.equal(assessWorkflowEvidence([{ ...check, evidence: undefined }]).passed, false);
});
