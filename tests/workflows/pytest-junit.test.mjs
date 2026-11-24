import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as core from '../../packages/testmind-core/workflow/index.js';
import { loadTs } from './operator-harness.mjs';

const require = createRequire(new URL('../../apps/api/package.json', import.meta.url));
const normalizer = loadTs('apps/api/src/runner/pytest-results.ts', { '@testmind/core/workflow': core });
const { parsePytestJUnit, normalizePytestJUnit, MAX_JUNIT_BYTES } = loadTs('apps/api/src/runner/pytest-junit.ts', {
  saxes: require('saxes'), './pytest-results.js': normalizer,
});
const suite = body => `<testsuites><testsuite>${body}</testsuite></testsuites>`;
const testcase = (body = '', attrs = '') => `<testcase classname="tests.test_cart" name="test_total[one]" time="0.012" ${attrs}>${body}</testcase>`;

test('JUnit: pytest xunit2 and xunit1 preserve identities, durations and decoded private diagnostics', () => {
  const xml = suite(testcase('<system-out><![CDATA[private <diagnostic>]]></system-out>', 'file="tests/test_cart.py"'));
  const result = normalizePytestJUnit(xml, { exitCode: 0 });
  assert.equal(result.quality.passed, true);
  assert.equal(result.cases[0].durationMs, 12);
  assert.equal(result.cases[0].file, 'tests/test_cart.py');
  assert.equal(result.cases[0].stdout[0], 'private <diagnostic>');
  assert.equal(parsePytestJUnit(suite(testcase())).cases[0].file, 'unknown');
});
for (const [element, outcome, exitCode] of [['failure', 'assertion-failure', 1], ['error', 'execution-error', 1], ['skipped', 'quality-gate-failure', 0]]) {
  test(`JUnit: ${element} cannot become success`, () => {
    const result = normalizePytestJUnit(suite(testcase(`<${element} message="safe &amp; decoded">details</${element}>`)), { exitCode });
    assert.equal(result.outcome, outcome);
    assert.equal(result.quality.passed, false);
    assert.equal(result.cases[0].message, 'safe & decoded\ndetails');
  });
}
for (const [message, phase] of [['collection failure', 'collection'], ['failed on setup with "ValueError"', 'setup'], ['failed on teardown with "ValueError"', 'teardown']]) {
  test(`JUnit: ${phase} phase is based on explicit pytest error metadata`, () => {
    const result = normalizePytestJUnit(suite(testcase(`<error message='${message}'>trace</error>`)), { exitCode: 2 });
    assert.equal(result.cases[0].phase, phase);
    assert.equal(result.outcome, phase === 'collection' ? 'collection-error' : 'execution-error');
  });
}
test('JUnit: empty report, absent report and valid zero tests never pass', () => {
  assert.equal(normalizePytestJUnit('', { exitCode: 0 }).outcome, 'invalid-report');
  assert.equal(normalizePytestJUnit(undefined, { exitCode: 0 }).outcome, 'invalid-report');
  for (const xml of ['<testsuites/>', '<testsuite tests="0" failures="0" errors="0" skipped="0"/>']) {
    assert.equal(normalizePytestJUnit(xml, { exitCode: 5 }).outcome, 'no-tests');
  }
});
test('JUnit: nested suites and declared counts must agree with actual cases', () => {
  const valid = `<testsuites tests="1"><testsuite tests="1" failures="0" errors="0" skipped="0">${testcase()}</testsuite></testsuites>`;
  assert.equal(parsePytestJUnit(valid).reportState, 'complete');
  assert.equal(parsePytestJUnit(valid.replace('tests="1"', 'tests="2"')).reportState, 'invalid');
});
test('JUnit: malformed, unsupported and ambiguous XML fails closed without disclosing contents', () => {
  const secret = 'synthetic-secret-do-not-log';
  const bad = [
    `<testsuite><testcase name="${secret}"></testsuite>`, '<testsuite/><testsuite/>',
    '<!DOCTYPE testsuite SYSTEM "file:///etc/passwd"><testsuite/>',
    '<!DOCTYPE testsuite [<!ENTITY x "expanded">]><testsuite>&x;</testsuite>',
    '<?xml version="1.0" encoding="UTF-16"?><testsuite/>', '<?unsafe data?><testsuite/>',
    '<testsuite>&unknown;</testsuite>', '<testsuite><unknown/></testsuite>',
    suite(testcase('<failure/><skipped/>')), suite(testcase() + testcase()),
    suite(testcase('', 'time="1"')), '<testsuite><testcase name="x" time="NaN"/></testsuite>',
    '<testsuite><testcase name="x" time="-1"/></testsuite>', '<testsuite tests="1"/>',
    '<testsuite>'.repeat(14) + '</testsuite>'.repeat(14), ' '.repeat(MAX_JUNIT_BYTES + 1),
  ];
  for (const xml of bad) {
    const result = parsePytestJUnit(xml);
    assert.equal(result.reportState, 'invalid');
    assert.equal(result.cases.length, 0);
    assert.equal(JSON.stringify(result).includes(secret), false);
  }
});
test('JUnit: expected skips and required verification use existing quality gates', () => {
  const xml = suite(testcase() + '<testcase classname="tests.test_cart" name="optional"><skipped/></testcase>');
  const id = JSON.stringify(['tests.test_cart', 'optional']);
  assert.equal(normalizePytestJUnit(xml, { exitCode: 0, expectedSkippedIds: [id] }).quality.passed, true);
  assert.equal(normalizePytestJUnit(xml, { exitCode: 0, expectedSkippedIds: [id], verifications: [{ id: 'full-suite', status: 'failed' }] }).quality.passed, false);
});
