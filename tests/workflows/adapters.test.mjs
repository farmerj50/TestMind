import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../../packages/testmind-core/workflow/index.js';
import { loadTs } from './operator-harness.mjs';
const analysis = loadTs('apps/api/src/lib/workflow-evidence.ts');
const planner = loadTs('apps/api/src/lib/autonomous-planner.ts');
const risk = loadTs('apps/api/src/lib/workflow-risk.ts', { './autonomous-planner.js': planner });
const failure = { id: 'assert-1', kind: 'assertion', runId: 'run-1', caseId: 'case-1', failureClass: 'failed', message: 'expected success' };
const signal = (kind, extra) => ({ id: `${kind}-1`, kind, runId: 'run-1', caseId: 'case-1', ...extra });
for (const [name, signals, verdict] of [
  ['server response alone does not prove an application defect', [signal('api-response', { status: 500 })], 'unknown'],
  ['selector syntax supports automation failure', [signal('trace', { message: 'invalid selector' })], 'automation-failure'],
  ['connection failure supports infrastructure failure', [signal('network', { message: 'ECONNREFUSED' })], 'infrastructure-failure'],
  ['backend application error supports application defect', [signal('backend-log', { failureClass: 'application-error', requestId: 'request-1' })], 'application-defect'],
  ['conflicting signals remain unknown', [signal('backend-log', { failureClass: 'application-error' }), signal('trace', { message: 'invalid selector' })], 'unknown'],
  ['screenshot alone is not a diagnosis', [signal('screenshot', { artifactId: 'shot-1' })], 'unknown'],
  ['unrelated run cannot contaminate root cause', [signal('api-response', { status: 500, runId: 'another-run' })], 'unknown'],
  ['unrelated case cannot contaminate root cause', [signal('api-response', { status: 500, caseId: 'another-case' })], 'unknown'],
]) test(`evidence: ${name}`, () => {
  const result = analysis.analyzeWorkflowEvidence([failure, ...signals]); assert.equal(result.verdict, verdict); assert.ok(result.evidenceIds.includes(failure.id));
});
test('correlation can follow a shared request ID and exposes missing evidence', () => {
  const result = analysis.analyzeWorkflowEvidence([{ ...failure, requestId: 'req-1' }, signal('backend-log', { caseId: undefined, requestId: 'req-1', failureClass: 'application-error' })]);
  assert.equal(result.verdict, 'application-defect'); assert.ok(result.findings[0].missingEvidence.includes('trace'));
});
test('risk selection preserves existing scores and applies test and generation limits', () => {
  const snapshot = { store: { pages: {} }, workflows: [
    { key: 'critical', name: 'Checkout', coveragePercent: 0, routeHints: ['/cart', '/pay'], riskTags: ['revenue'] },
    { key: 'low', name: 'About', coveragePercent: 100, routeHints: ['/about'], riskTags: [] },
    { key: 'unknown', name: 'Unknown', coveragePercent: null, routeHints: [], riskTags: [] },
  ], coverage: [{ routeHint: '/cart', testCaseId: 'cart-1', confidence: 'linked' }], qaFailures: [], securityFindings: { attributed: [], notAttributable: [] } };
  const result = risk.selectWorkflowRisk(snapshot, '2026-11-09T00:00:00Z', 1, 2);
  assert.equal(result.selected.length, 1); assert.equal(result.selected[0].key, 'critical'); assert.equal(result.selected[0].score, 45);
  assert.equal(result.selectedTestIds[0], 'cart-1'); assert.equal(result.proposedTests[0].route, '/pay'); assert.equal(result.unrankable.length, 1);
  assert.throws(() => risk.selectWorkflowRisk(snapshot, '2026-11-09T00:00:00Z', 1, 0), /bounds/);
});
const service = loadTs('apps/api/src/runner/api-test-service.ts', { undici: {}, '../prisma.js': { prisma: {} }, '@testmind/core/workflow': core, '../lib/workflow-http.js': {}, '../lib/workflow-execution-policy.js': {} });

test('atomic child claim permits one executor and preserves completed runs on redelivery', async () => {
  const policy = loadTs('apps/api/src/lib/workflow-execution-policy.ts', { '../prisma.js': {}, './workflow-version.js': {}, '@testmind/core/workflow': core });
  let status = 'queued';
  const model = { updateMany: async ({ where, data }) => { if (status !== where.status) return { count: 0 }; status = data.status; return { count: 1 }; } };
  assert.deepEqual(await Promise.all([policy.claimWorkflowChildRun(model, 'child'), policy.claimWorkflowChildRun(model, 'child')]), [true, false]);
  status = 'completed'; assert.equal(await policy.claimWorkflowChildRun(model, 'child'), false); assert.equal(status, 'completed');
});

test('actual UI worker exits duplicate delivery before preparing files or launching tests', async () => {
  let callback, launched = 0;
  class Worker { constructor(_name, fn) { callback = fn; } on() { return this; } }
  const model = { findUnique: async () => ({ project: { id: 'project' }, paramsJson: {} }), updateMany: async () => ({ count: 0 }) };
  const policy = loadTs('apps/api/src/lib/workflow-execution-policy.ts', { '../prisma.js': {}, './workflow-version.js': {}, '@testmind/core/workflow': core });
  loadTs('apps/api/src/runner/worker.ts', {
    bullmq: { Worker }, 'fs/promises': {}, fs: {}, execa: {}, '../prisma.js': { prisma: { testRun: model } }, './redis.js': { redis: {} },
    './workdir.js': {}, './git.js': {}, './node-test-exec.js': { runTests: () => launched++ }, '../lib/qe-credentials.js': {}, '../lib/repair-verification.js': {}, '../testmind/pipeline/qe-codegen.js': { QE_AUTH_ENV: { email: 'TM_QE_AUTH_EMAIL', password: 'TM_QE_AUTH_PASSWORD', loginPath: 'TM_QE_LOGIN_PATH' } }, './result-parsers.js': {}, './persist-run-results.js': {}, './self-heal.js': {}, './finalize-latest-test-state.js': {},
    './ai-run-target.js': { resolveAiGeneratedDir: () => undefined, resolveExistingAiTarget: () => null },
    '../ai/core/policy.js': { readSelfHealPolicy: () => ({}) }, '../lib/locator-promotion.js': {}, './ai-analysis.js': {}, '../lib/storageRoots.js': {}, '../lib/workflow-execution-policy.js': policy, '../lib/workflow-http.js': {}, '../lib/crypto.js': {}, '../testmind/service.js': {}, '@testmind/core/framework': {}, '../lib/git-url.js': {},
  });
  await callback({ data: { runId: 'completed', payload: { projectId: 'project', workflowRunId: 'parent' } } });
  assert.equal(launched, 0);
});
test('API schema assertions enforce nested fields, types and additional properties', () => {
  const schema = { type: 'object', required: ['user'], additionalProperties: false, properties: { user: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } } } };
  const [bad] = service.evaluateAssertions([{ type: 'schema_validates', schema }], 200, 1, {}, { user: { id: 'wrong' } });
  const [good] = service.evaluateAssertions([{ type: 'schema_validates', schema }], 200, 1, {}, { user: { id: 1 } });
  assert.equal(bad.passed, false); assert.equal(good.passed, true);
});
test('unsupported schema keywords fail visibly rather than silently passing', () => {
  const [result] = service.evaluateAssertions([{ type: 'schema_validates', schema: { type: 'object', inventedKeyword: true } }], 200, 1, {}, {});
  assert.equal(result.passed, false); assert.match(result.error, /unknown keyword/);
});
function handlers(prisma) {
  return loadTs('apps/api/src/runner/workflow-handlers.ts', {
    'node:fs/promises': {}, '@testmind/core/workflow': core, '../prisma.js': { prisma }, './queue.js': { enqueueApiTestRun: async () => {} },
    '../lib/workflow-http.js': { validateWorkflowTarget: async () => {} }, '../security/openapi-parser.js': {}, '../testmind/discover.js': {},
    '../testmind/pipeline/generate-plan.js': {}, '../testmind/pipeline/codegen.js': {}, '../lib/storageRoots.js': {},
    '../lib/application-brain-query.js': {}, '../lib/workflow-risk.js': risk, '../lib/workflow-evidence.js': analysis, './workflow-evidence-collector.js': {},
  });
}
test('API adapter rejects a collection outside the project before dispatch', async () => {
  let scope;
  const adapter = handlers({ apiCollection: { findFirst: async ({ where }) => { scope = where; return null; } } });
  await assert.rejects(adapter.executeWorkflowHandler({ node: { type: 'api.suite' }, inputs: { collectionId: 'foreign' }, run: { workflow: { projectId: 'owned' } } }), /not found/);
  assert.equal(scope.projectId, 'owned'); assert.equal(scope.id, 'foreign');
});

test('child creation waits for its durable checkpoint and resumes with the same identifier', async () => {
  const created = [], checkpointState = { childId: 'wf-api-node-task', requiredCaseIds: ['t1'] };
  const adapter = handlers({ apiCollection: { findFirst: async () => ({ id: 'collection', baseUrl: 'https://example.test', testCases: [{ id: 't1' }] }) }, apiTestRun: {
    upsert: async ({ where }) => created.push(where.id), findUniqueOrThrow: async () => ({ status: 'queued' }),
  } });
  const context = { node: { type: 'api.suite' }, inputs: { collectionId: 'collection' }, task: { id: 'node-task', state: {} }, run: { id: 'workflow-run', workflow: { projectId: 'owned' } } };
  await assert.rejects(adapter.executeWorkflowHandler({ ...context, checkpoint: async () => { throw new Error('checkpoint unavailable'); } }), /checkpoint unavailable/);
  assert.equal(created.length, 0);
  const result = await adapter.executeWorkflowHandler({ ...context, task: { ...context.task, state: { checkpoint: checkpointState } }, checkpoint: async () => { throw new Error('checkpoint repeated'); } });
  assert.equal(result.pending, true); assert.deepEqual(created, ['wf-api-node-task']);
});
for (const [name, rows] of [['zero tests', []], ['failed assertion', [{ id: 'r1', testCaseId: 't1', status: 'failed' }]], ['missing expected test', [{ id: 'r2', testCaseId: 'different', status: 'passed' }]]]) test(`API completed status cannot override ${name}`, async () => {
  const adapter = handlers({ apiCollection: { findFirst: async () => ({ id: 'collection', baseUrl: 'https://example.test', testCases: [{ id: 't1' }] }) }, apiTestRun: { upsert: async () => {}, findUniqueOrThrow: async () => ({ status: 'completed', results: rows }) } });
  const result = await adapter.executeWorkflowHandler({ node: { type: 'api.suite' }, inputs: { collectionId: 'collection' }, task: { id: 'node-task', state: {} }, checkpoint: async () => {}, run: { id: 'workflow-run', workflow: { projectId: 'owned' } } });
  assert.equal(result.outcome, 'failed'); assert.equal(result.branch, 'failure');
});
for (const [status, rows, outcome] of [['completed', [{ id: 'r1', testCaseId: 't1', status: 'passed' }], 'passed'], ['failed', [{ id: 'r1', testCaseId: 't1', status: 'passed' }], 'failed']]) test(`API run '${status}' with every expected test passing is judged '${outcome}' by the quality gate`, async () => {
  const adapter = handlers({ apiCollection: { findFirst: async () => ({ id: 'collection', baseUrl: 'https://example.test', testCases: [{ id: 't1' }] }) }, apiTestRun: { upsert: async () => {}, findUniqueOrThrow: async () => ({ status, results: rows }) } });
  const result = await adapter.executeWorkflowHandler({ node: { type: 'api.suite' }, inputs: { collectionId: 'collection' }, task: { id: 'node-task', state: {} }, checkpoint: async () => {}, run: { id: 'workflow-run', workflow: { projectId: 'owned' } } });
  assert.equal(result.outcome, outcome); assert.equal(result.branch, outcome === 'passed' ? 'success' : 'failure');
  assert.equal(result.evidence.status, status === 'completed' ? 'succeeded' : 'failed');
});
