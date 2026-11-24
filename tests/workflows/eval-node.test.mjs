// Phase 2 acceptance tests for the eval.run node type, per the master plan's explicit
// requirement: quality-gate failures, duplicate-result prevention, and cancellation
// propagation must be verified with real tests, not assumed-inherited.
import test from 'node:test';
import assert from 'node:assert/strict';
import { evalNodeHarness, evalGraph, evalGraphWithDatasetVersion } from './eval-node-harness.mjs';

test('eval.run resolves to the success branch when overallGateStatus is pass', async () => {
  const h = evalNodeHarness();
  await h.until(() => h.dispatchedRunIds.length === 1);
  await h.settleChild('succeeded', 'pass');
  await h.finish();
  const task = h.rows.find(r => r.nodeKey === 'eval');
  assert.equal(task.outputJson.branch, 'success');
  assert.equal(task.outputJson.outcome, 'passed');
});

test('eval.run resolves to the failure branch when overallGateStatus is fail - never silently passes', async () => {
  const h = evalNodeHarness();
  await h.until(() => h.dispatchedRunIds.length === 1);
  await h.settleChild('succeeded', 'fail');
  await h.finish();
  const task = h.rows.find(r => r.nodeKey === 'eval');
  assert.equal(task.outputJson.branch, 'failure');
  assert.equal(task.outputJson.outcome, 'failed');
});

test('eval.run resolves to the failure branch when overallGateStatus is skipped_no_data - never silently passes', async () => {
  const h = evalNodeHarness();
  await h.until(() => h.dispatchedRunIds.length === 1);
  await h.settleChild('succeeded', 'skipped_no_data');
  await h.finish();
  const task = h.rows.find(r => r.nodeKey === 'eval');
  assert.equal(task.outputJson.branch, 'failure');
  assert.equal(task.outputJson.outcome, 'failed');
  assert.equal(task.outputJson.evidence.counts.skipped, 1);
});

test('eval.run never creates a second EvaluationRun across repeated ticks while the child is in flight, and always targets the same deterministic child id', async () => {
  const h = evalNodeHarness();
  // Drive several ticks while the child stays queued - simulates re-ticks/a resumed crash.
  // The handler re-calling enqueue every tick while status is still 'queued' matches the
  // existing api.suite precedent exactly; it is BullMQ's own jobId dedup (same runId -> same
  // job, confirmed in queue.ts's enqueueEvaluationRun) that collapses these into one real job,
  // not the handler refusing to call enqueue again. What the handler itself must guarantee is
  // the DB row: exactly one EvaluationRun, and every call targeting that same deterministic id.
  for (let i = 0; i < 5; i++) await h.tick();
  assert.equal(h.evaluationRuns.size, 1, 'exactly one EvaluationRun must exist for this node attempt');
  assert.ok(h.dispatchedRunIds.length >= 1, 'enqueue should have been attempted at least once');
  assert.ok(h.dispatchedRunIds.every(id => id === h.dispatchedRunIds[0]), 'every enqueue attempt must target the same deterministic child id');
  await h.settleChild('succeeded', 'pass');
  await h.finish();
  assert.equal(h.evaluationRuns.size, 1, 'settling and finishing must not create a second row');
});

test('canceling the workflow run stops further ticking of an in-flight eval.run node without touching its child EvaluationRun', async () => {
  const h = evalNodeHarness();
  await h.until(() => h.dispatchedRunIds.length === 1);
  const childId = h.childId();
  const childBefore = h.evaluationRuns.get(childId).status;
  assert.equal(childBefore, 'queued');
  const taskBefore = h.rows.find(r => r.nodeKey === 'eval');
  assert.equal(taskBefore.status, 'running');

  // Mirrors what POST /workflows/runs/:id/cancel does: mark the WorkflowRun canceled.
  h.run.status = 'canceled';
  const result = await h.tick();

  assert.equal(result.status, 'canceled');
  const taskAfter = h.rows.find(r => r.nodeKey === 'eval');
  assert.equal(taskAfter.status, 'running', 'the in-flight node task is left as-is, not force-completed');
  // Honest limitation (matches existing api.suite/ui.suite precedent): the child job itself
  // is never actively aborted by cancellation - it is simply never polled again.
  assert.equal(h.evaluationRuns.get(childId).status, 'queued', 'the child EvaluationRun is orphaned, not canceled, matching existing engine precedent');
});

// Phase 3: eval.run resolving cases from a pinned golden dataset version instead of inline cases.

test('eval.run resolves cases from a datasetVersionId when inline cases are absent', async () => {
  const datasetVersions = new Map([['dv-1', { id: 'dv-1', casesJson: [{ case_id: 'pinned-1' }, { case_id: 'pinned-2' }] }]]);
  const h = evalNodeHarness({ graph: evalGraphWithDatasetVersion('dv-1'), datasetVersions });
  await h.until(() => h.dispatchedRunIds.length === 1);
  const childId = h.childId();
  assert.deepEqual(h.evaluationRuns.get(childId).casesJson, [{ case_id: 'pinned-1' }, { case_id: 'pinned-2' }]);
});

test('eval.run throws a clear error when neither cases nor datasetVersionId is provided', async () => {
  const graph = evalGraph({
    datasetId: { kind: 'constant', value: 'ds-1' }, datasetVersion: { kind: 'constant', value: 'v1' },
    applicationId: { kind: 'constant', value: 'app-1' }, applicationVersion: { kind: 'constant', value: 'v1' },
  });
  const h = evalNodeHarness({ graph });
  await h.finish();
  const task = h.rows.find(r => r.nodeKey === 'eval');
  assert.equal(task.status, 'failed');
  assert.match(task.error, /requires either "cases" or "datasetVersionId"/);
});

test('eval.run throws a clear error when datasetVersionId does not resolve in this project', async () => {
  const h = evalNodeHarness({ graph: evalGraphWithDatasetVersion('does-not-exist'), datasetVersions: new Map() });
  await h.finish();
  const task = h.rows.find(r => r.nodeKey === 'eval');
  assert.equal(task.status, 'failed');
  assert.match(task.error, /dataset version not found/i);
});

// Phase 5: re-verify the idempotency/duplicate-result guarantee (already proven for inline
// cases) also holds when cases are sourced from a datasetVersionId - resolving the pinned
// version on every tick must not create a second EvaluationRun or a second dispatch.
test('eval.run sourcing cases from a datasetVersionId never creates a second EvaluationRun across repeated ticks', async () => {
  const datasetVersions = new Map([['dv-1', { id: 'dv-1', casesJson: [{ case_id: 'pinned-1' }] }]]);
  const h = evalNodeHarness({ graph: evalGraphWithDatasetVersion('dv-1'), datasetVersions });
  for (let i = 0; i < 5; i++) await h.tick();
  assert.equal(h.evaluationRuns.size, 1, 'exactly one EvaluationRun must exist for this node attempt');
  assert.ok(h.dispatchedRunIds.length >= 1);
  assert.ok(h.dispatchedRunIds.every(id => id === h.dispatchedRunIds[0]), 'every enqueue attempt must target the same deterministic child id');
  await h.settleChild('succeeded', 'pass');
  await h.finish();
  assert.equal(h.evaluationRuns.size, 1, 'settling and finishing must not create a second row');
  assert.deepEqual(h.evaluationRuns.get(h.childId()).casesJson, [{ case_id: 'pinned-1' }]);
});
