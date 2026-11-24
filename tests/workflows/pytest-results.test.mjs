import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../../packages/testmind-core/workflow/index.js';
import { loadTs } from './operator-harness.mjs';

const { normalizePytestResults } = loadTs('apps/api/src/runner/pytest-results.ts', { '@testmind/core/workflow': core });
const passing = { id: 'tests/test_cart.py::test_total[one]', file: 'tests/test_cart.py', fullName: 'test_total[one]', status: 'passed', durationMs: 12 };
const normalize = overrides => normalizePytestResults({ cases: [passing], exitCode: 0, reportState: 'complete', ...overrides });
const failed = (overrides, outcome) => {
  const result = normalize(overrides);
  assert.equal(result.outcome, outcome);
  assert.equal(result.quality.passed, false);
  assert.notEqual(result.evidence.status, 'succeeded');
  assert.equal(core.assessWorkflowEvidence([{ id: 'pytest', status: 'succeeded', testsRequired: true, evidence: result.evidence }]).passed, false);
  return result;
};

test('pytest: parametrized case identities, durations and required evidence survive normalization', () => {
  const second = { ...passing, id: 'tests/test_cart.py::test_total[two]', fullName: 'test_total[two]' };
  const result = normalize({ cases: [passing, second], requiredCaseIds: [passing.id, second.id] });
  assert.equal(result.outcome, 'passed');
  assert.equal(result.quality.passed, true);
  assert.equal(result.evidence.counts.passed, 2);
  assert.deepEqual(result.cases, [passing, second]);
  assert.equal(core.assessWorkflowEvidence([{ id: 'pytest', status: 'succeeded', testsRequired: true, evidence: result.evidence }]).passed, true);
});

for (const exitCode of [0, 1]) test(`pytest: assertion evidence overrides process exit ${exitCode}`, () => {
  const result = failed({ exitCode, cases: [{ ...passing, status: 'failed', phase: 'call' }] }, 'assertion-failure');
  assert.equal(result.evidence.counts.failed, 1);
});
for (const phase of ['setup', 'teardown']) test(`pytest: ${phase} errors remain execution failures`, () => {
  const result = failed({ exitCode: 1, cases: [{ ...passing, status: 'error', phase }] }, 'execution-error');
  assert.equal(result.evidence.counts.errors, 1);
});
test('pytest: collection classification requires collection evidence, not exit 2 alone', () => {
  failed({ exitCode: 2, cases: [{ ...passing, status: 'error', phase: 'collection' }] }, 'collection-error');
  failed({ exitCode: 2 }, 'execution-error');
});
for (const exitCode of [1, 3, 4, 5, 99, null]) test(`pytest: contradictory or unsuccessful exit ${exitCode} cannot pass`, () => {
  failed({ exitCode }, 'execution-error');
});
for (const termination of ['timeout', 'canceled']) test(`pytest: ${termination} overrides a passing or missing report`, () => {
  failed({ termination }, termination);
  failed({ termination, reportState: 'missing', cases: [] }, termination);
});
test('pytest: zero collected tests are distinct from runner failures', () => {
  for (const exitCode of [0, 5]) failed({ exitCode, cases: [] }, 'no-tests');
  failed({ exitCode: 1, cases: [] }, 'execution-error');
});
test('pytest: unexpected skips fail; explicit expected skips retain required-case gates', () => {
  const skip = { ...passing, id: 'optional', status: 'skipped' };
  failed({ cases: [passing, skip] }, 'quality-gate-failure');
  assert.equal(normalize({ cases: [passing, skip], expectedSkippedIds: [skip.id] }).quality.passed, true);
  failed({ cases: [passing, skip], expectedSkippedIds: [skip.id], requiredCaseIds: [skip.id] }, 'quality-gate-failure');
  failed({ cases: [skip], expectedSkippedIds: [skip.id] }, 'quality-gate-failure');
});
test('pytest: missing cases, failed assertions and targeted/full verification block success', () => {
  failed({ requiredCaseIds: ['missing'] }, 'quality-gate-failure');
  failed({ assertions: [{ id: 'required', status: 'failed' }] }, 'quality-gate-failure');
  for (const id of ['targeted', 'full-suite']) for (const status of ['failed', 'skipped']) {
    failed({ verifications: [{ id, status }] }, 'quality-gate-failure');
  }
});
test('pytest: missing/invalid reports, unknown statuses and duplicate identities fail closed', () => {
  for (const reportState of ['missing', 'invalid', 'unsupported']) {
    assert.equal(failed({ reportState }, 'invalid-report').evidence.counts.total, 0);
  }
  for (const cases of [null, [passing, passing], [{ ...passing, status: 'unknown' }], [{ ...passing, id: '' }],
    [{ ...passing, phase: 'collection' }], [{ ...passing, phase: 'unknown' }],
    [{ ...passing, durationMs: NaN }], [{ ...passing, durationMs: -1 }], Array(10_001).fill(passing)]) {
    assert.equal(failed({ cases }, 'invalid-report').evidence.counts.total, 0);
  }
});
test('pytest: normalization retains private diagnostics without logging them', () => {
  const messages = [];
  const parser = loadTs('apps/api/src/runner/pytest-results.ts', { '@testmind/core/workflow': core }, {
    console: { log: (...args) => messages.push(args), warn: (...args) => messages.push(args), error: (...args) => messages.push(args) },
  });
  const message = 'synthetic-private-diagnostic';
  const result = parser.normalizePytestResults({ cases: [{ ...passing, status: 'failed', message }], exitCode: 1, reportState: 'complete' });
  assert.equal(result.cases[0].message, message);
  assert.equal(JSON.stringify(result.quality).includes(message), false);
  assert.deepEqual(messages, []);
});
