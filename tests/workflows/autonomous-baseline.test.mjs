import test from 'node:test';
import assert from 'node:assert/strict';
import { createOperatorHarness } from './operator-harness.mjs';

test('disabled autonomous QA fails before discovering or enqueueing tests', async () => {
  const h = createOperatorHarness({ enabled: false });
  await assert.rejects(h.tick(), /not enabled/);
  assert.equal(h.status, 'failed');
  assert.equal(h.calls.discoveries, 0);
  assert.equal(h.calls.runs.length, 0);
});

test('a canceled operator job performs no work', async () => {
  const h = createOperatorHarness();
  h.tables.operatorJob[0].status = 'canceled';
  await h.tick();
  assert.equal(h.status, 'canceled');
  assert.equal(h.calls.discoveries, 0);
});

test('discovery creates a queued suite and checkpoint; waiting is not a success', async () => {
  const h = createOperatorHarness();
  assert.equal(await h.tick(), 'delayed');
  assert.equal(h.status, 'running');
  assert.equal(h.state.stage, 'wait_initial_run');
  assert.equal(h.calls.discoveries, 1);
  assert.equal(h.calls.generated, 1);
  assert.equal(h.calls.runs.length, 1);
  assert.equal(h.calls.runs[0].file, h.generatedDir);
  assert.equal(h.tables.testRun[0].paramsJson.disableAutoSelfHeal, true);
  assert.equal(await h.tick(), 'delayed');
  assert.equal(h.calls.runs.length, 1);
});

test('a new worker instance resumes the checkpoint without repeating discovery', async () => {
  const h = createOperatorHarness();
  await h.tick();
  h.restart();
  h.finishRun();
  assert.equal(await h.tick(), 'completed');
  assert.equal(h.status, 'succeeded');
  assert.equal(h.calls.discoveries, 1);
  assert.equal(h.calls.runs.length, 1);
  assert.ok(h.tables.operatorTask.some(t => t.outputJson?.phase === 'full-suite-verification'));
});

test('an application assertion failure stays failed and does not trigger selector repair', async () => {
  const h = createOperatorHarness();
  await h.tick();
  h.finishRun('failed', [{ status: 'failed', message: 'Expected 200, received 500' }]);
  await assert.rejects(h.tick(), /human intervention/);
  assert.equal(h.status, 'failed');
  assert.equal(h.calls.heals.length, 0);
  assert.equal(h.tables.humanInterventionCandidate.length, 1);
  assert.equal(h.tables.operatorDecision[0].decisionType, 'escalate');
});

test('an infrastructure failure remains a failure with recorded evidence', async () => {
  const h = createOperatorHarness();
  await h.tick();
  h.finishRun('failed', [{ status: 'failed', message: 'net::ERR_CONNECTION_REFUSED' }]);
  await assert.rejects(h.tick(), /human intervention/);
  assert.equal(h.calls.heals.length, 0);
  assert.equal(h.tables.humanInterventionCandidate[0].contextJson.type, 'blocked');
});

async function repairing() {
  const h = createOperatorHarness();
  await h.tick();
  h.finishRun('failed', [{ status: 'failed', message: 'locator not found' }]);
  assert.equal(await h.tick(), 'delayed');
  assert.equal(h.state.stage, 'wait_repair');
  return h;
}

test('repair is followed by targeted verification and then a full-suite verification', async () => {
  const h = await repairing();
  assert.equal(h.calls.heals.length, 1);
  assert.equal(h.calls.heals[0].skipAutoRerun, true);
  h.finishRepair();
  await h.tick();
  assert.equal(h.state.stage, 'wait_targeted_verify');
  assert.equal(h.status, 'running');
  h.finishRun();
  await h.tick();
  assert.equal(h.state.stage, 'wait_full_verify');
  assert.equal(h.tables.testHealingAttempt[0].status, 'succeeded', 'success only after the verification rerun passed');
  assert.deepEqual(h.tables.testHealingAttempt[0].executionAfter && h.tables.testHealingAttempt[0].executionAfter.failed, 0);
  assert.equal(h.calls.runs.length, 3);
  assert.equal(h.calls.runs[2].file, h.generatedDir);
  h.finishRun();
  await h.tick();
  assert.equal(h.status, 'succeeded');
});

test('full-suite verification failure cannot complete a repair job successfully', async () => {
  const h = await repairing();
  h.finishRepair();
  await h.tick();
  h.finishRun();
  await h.tick();
  h.finishRun('failed', [{ status: 'failed', message: 'Expected cart total 20, received 30' }]);
  await assert.rejects(h.tick(), /full-suite verification failed/);
  assert.equal(h.status, 'failed');
});

async function repairedSharedFile() {
  const h = createOperatorHarness(); await h.tick();
  h.finishRun('failed', [{ status: 'failed', message: 'locator not found' }, { status: 'failed', message: 'locator not found' }]);
  await h.tick(); h.finishRepair(); await h.tick(); h.finishRun(); await h.tick();
  assert.equal(h.state.stage, 'wait_full_verify');
  assert.equal(h.calls.heals.length, 1, 'No stale request before current suite evidence');
  return h;
}
test('stale repair: shared-file patch is verified before another proposal', async () => {
  const h = await repairedSharedFile();
  h.finishRun('succeeded', [{ status: 'passed' }, { status: 'passed' }]); await h.tick();
  assert.equal(h.status, 'succeeded'); assert.equal(h.calls.heals.length, 1);
  assert.equal(h.tables.testResult.filter(r => r.runId === h.calls.runs[0].id && r.status === 'failed').length, 2);
});
test('stale repair: remaining failure uses fresh run evidence', async () => {
  const h = await repairedSharedFile();
  const freshRun = h.finishRun('failed', [{ status: 'passed' }, { status: 'failed', message: 'invalid selector' }]);
  await h.tick(); assert.equal(h.state.stage, 'wait_repair');
  assert.equal(h.calls.heals.length, 2); assert.equal(h.calls.heals[1].runId, freshRun);
  assert.equal(h.calls.heals[1].testResultId, `${freshRun}-result-1`);
});
for (const failure of ['ambiguous', 'new', 'skipped']) test(`stale repair: ${failure} evidence cannot authorize continuation`, async () => {
  const h = await repairedSharedFile();
  h.finishRun('failed', failure === 'new'
    ? [{ status: 'failed', message: 'invalid selector' }, { status: 'passed' }]
    : [{ status: 'passed' }, { status: failure === 'skipped' ? 'skipped' : 'failed', message: 'expected completion text' }]);
  await assert.rejects(h.tick()); assert.equal(h.status, 'failed'); assert.equal(h.calls.heals.length, 1);
});

test('failed repairs are recorded and the full suite is still verified', async () => {
  const h = await repairing();
  h.finishRepair('failed');
  await h.tick();
  assert.equal(h.state.stage, 'wait_full_verify');
  assert.equal(h.state.failedRepairResultIds.length, 1);
  assert.ok(h.tables.humanInterventionCandidate.some(i => /could not repair/.test(i.reason)));
  h.finishRun('failed', [{ status: 'failed', message: 'locator still missing' }]);
  await assert.rejects(h.tick(), /full-suite verification failed/);
});

test('test-run timeouts fail the job and mark its pending child run failed', async () => {
  const h = createOperatorHarness();
  await h.tick();
  h.state.deadline = 0;
  await assert.rejects(h.tick(), /timed out/i);
  assert.equal(h.status, 'failed');
  assert.equal(h.tables.testRun[0].status, 'failed');
});

test('active security work waits for approval and cannot start after denial', async () => {
  const h = createOperatorHarness({ type: 'security', context: { enableActive: true } });
  assert.equal(await h.tick(), 'delayed');
  assert.equal(h.status, 'blocked');
  assert.equal(h.calls.scans.length, 0);
  h.tables.operatorApproval[0].status = 'denied';
  await assert.rejects(h.tick(), /Approval denied/);
  assert.equal(h.calls.scans.length, 0);
  assert.equal(h.status, 'failed');
});

test('approved security work forwards its recorded approval to the scan worker', async () => {
  const h = createOperatorHarness({ type: 'security', context: { enableActive: true } });
  await h.tick();
  h.tables.operatorApproval[0].status = 'approved';
  await h.tick();
  assert.equal(h.calls.scans.length, 1);
  assert.equal(h.calls.scans[0].approvalGranted, true);
});

// These regressions failed during baseline characterization before R1.2.
for (const [name, results] of [
  ['zero collected tests', []],
  ['failed assertions behind a succeeded run status', [{ status: 'failed', message: 'assertion failed' }]],
  ['unexpectedly skipped tests', [{ status: 'skipped' }]],
  ['execution errors', [{ status: 'error' }]],
  ['unknown result status', [{ status: 'pending' }]],
]) {
  test(`quality gate: ${name} must not succeed`, async () => {
    const h = createOperatorHarness();
    await h.tick();
    h.finishRun('succeeded', results);
    try { await h.tick(); } catch { /* rejection is an acceptable outcome */ }
    assert.notEqual(h.status, 'succeeded');
  });
}

test('quality gate: failed targeted verification must not be hidden by a later full-suite pass', async () => {
  const h = await repairing();
  h.finishRepair();
  await h.tick();
  h.finishRun('failed', [{ status: 'failed', message: 'locator still missing' }]);
  await h.tick();
  // The patch applied but the verification rerun failed: repair_failed, never success.
  const attempt = h.tables.testHealingAttempt[0];
  assert.equal(attempt.status, 'failed');
  assert.match(attempt.error, /^repair_failed: /);
  const repairTask = h.tables.operatorTask.find(t => t.type === 'repair');
  assert.equal(repairTask.status, 'failed');
  assert.match(repairTask.error, /^repair_failed: /);
  assert.equal(repairTask.outputJson.finalStatus, 'repair_failed');
  h.finishRun();
  try { await h.tick(); } catch { /* expected once evidence gates are enforced */ }
  assert.notEqual(h.status, 'succeeded');
});

test('full verification cannot silently omit an initially collected test', async () => {
  const h = await repairing(); h.finishRepair(); await h.tick(); h.finishRun(); await h.tick();
  h.finishRun('succeeded', [{ status: 'passed', testCaseId: 'different-case' }]);
  await assert.rejects(h.tick(), /full-suite verification failed/);
  assert.equal(h.status, 'failed');
});

test('failed repair cannot be hidden by a later full-suite pass', async () => {
  const h = await repairing(); h.finishRepair('failed'); await h.tick(); h.finishRun();
  await assert.rejects(h.tick(), /required repair or targeted verification failed/);
  assert.equal(h.status, 'failed');
});

for (const autonomyLevel of ['assisted', 'autonomous-testing']) test(`${autonomyLevel} records failure without automatic repair`, async () => {
  const h = createOperatorHarness({ context: { autonomyLevel } }); await h.tick();
  h.finishRun('failed', [{ status: 'failed', message: 'locator not found' }]);
  await assert.rejects(h.tick(), /Automatic repair is disabled/);
  assert.equal(h.calls.heals.length, 0); assert.equal(h.status, 'failed');
});

test('unknown autonomy level fails before external work', async () => {
  const h = createOperatorHarness({ context: { autonomyLevel: 'unrestricted' } });
  await assert.rejects(h.tick(), /Unknown autonomy level/); assert.equal(h.calls.discoveries, 0);
});
