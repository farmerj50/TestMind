import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as core from '../../packages/testmind-core/workflow/index.js';
import { loadTs } from './operator-harness.mjs';

const inputsModule = loadTs('apps/api/src/runner/python-inputs.ts', { '@testmind/core/workflow': core });
const { preparePythonInputs, boundedPythonJson } = inputsModule;
const normalizer = loadTs('apps/api/src/runner/pytest-results.ts', { '@testmind/core/workflow': core });
const require = createRequire(new URL('../../apps/api/package.json', import.meta.url));
const junit = loadTs('apps/api/src/runner/pytest-junit.ts', { saxes: require('saxes'), './pytest-results.js': normalizer });
const allowed = () => ({ projectOwned: true, permissions: ['workflow:execute'], environmentAllowed: true,
  approvalRequired: true, approvalGranted: true, withinLimits: true });
const schema = { value: { type: 'json', required: true, secret: false } };
const request = () => ({ script: 'def main(inputs):\n    return inputs', declarations: schema, inputs: { value: 3 }, timeoutMs: 1000 });
const context = () => ({ sandbox: {}, autonomy: 'assisted', authorize: async () => allowed(), signal: new AbortController().signal,
  deadline: Date.now() + 10000, secretValues: ['synthetic-project-credential'] });
const result = (overrides = {}) => normalizer.normalizePytestResults({ exitCode: 0, reportState: 'complete', cases: [{
  id: JSON.stringify(['test_testmind_script', 'test_script']), file: 'unknown', fullName: 'test_script', status: 'passed',
  scriptResult: { status: 'completed', json: '{"answer":3}' }, ...overrides,
}] });
const adapter = runner => loadTs('apps/api/src/runner/python-script.ts', {
  '@testmind/core/workflow': core, './pytest-sandbox.js': { runIsolatedPytest: runner }, './python-inputs.js': inputsModule,
}).executePythonScript;

test('inputs: declared types and permitted files are copied, optional inputs remain absent', () => {
  const values = { value: { nested: [1, true, null] }, title: 'example', count: 2, enabled: true };
  const prepared = preparePythonInputs({ ...schema, title: { type: 'string', required: true, path: 'inputs/note.txt' },
    count: { type: 'number', required: true, path: 'inputs/sub/count.json' }, enabled: { type: 'boolean', required: true },
    optional: { type: 'string', required: false } }, values, []);
  values.value.nested.push('later');
  assert.equal(prepared.inputs.value.nested.length, 3);
  assert.equal(prepared.files['inputs/note.txt'], 'example');
  assert.equal(prepared.files['inputs/sub/count.json'], '2');
  assert.equal(Object.hasOwn(prepared.inputs, 'optional'), false);
});
test('inputs: undeclared, missing, mistyped, secret-bound and unsupported inputs are rejected', () => {
  const bad = [
    [schema, { value: 1, extra: 2 }], [schema, {}], [{ value: { type: 'number', required: true } }, { value: '1' }],
    [{ value: { type: 'string', required: true, secret: true } }, { value: 'secret-value' }],
    [{ value: { type: 'path', required: true } }, { value: '/etc/passwd' }],
    [{ value: { type: 'json', required: true, binding: { kind: 'secret' } } }, { value: 1 }],
    [{ 'bad-name': { type: 'string', required: true } }, { 'bad-name': 'x' }],
    [schema, { value: 'synthetic-project-credential' }], [schema, { value: { password: 'do-not-print' } }],
    [schema, { value: 'Bearer synthetic-header-token' }], [schema, { value: 'x'.repeat(65536) }],
  ];
  for (const [declarations, values] of bad) assert.throws(() => preparePythonInputs(declarations, values, ['synthetic-project-credential']), /^Error: PYTHON_INPUT_UNSAFE$/);
});
test('inputs: traversal, absolute paths, separators, aliases and collisions cannot escape confinement', () => {
  for (const path of ['../escape.txt', '/etc/passwd', 'C:/host.txt', 'inputs/../escape.txt', 'inputs\\escape.txt',
    'inputs//file.txt', 'inputs/%2e%2e/file.txt', 'inputs/file.py', 'inputs/.hidden.txt', 'inputs/foo:bar.txt']) {
    assert.throws(() => preparePythonInputs({ value: { type: 'string', required: true, path } }, { value: 'text' }, []), /PYTHON_INPUT_UNSAFE/);
  }
  assert.throws(() => preparePythonInputs({ a: { type: 'string', required: false, path: 'inputs/a.txt' },
    b: { type: 'string', required: false, path: 'inputs/A.txt' } }, {}, []), /PYTHON_INPUT_UNSAFE/);
});
test('inputs: unsafe JSON cannot invoke getters, prototypes, serialization hooks or unbounded recursion', () => {
  let invoked = false;
  const getter = Object.defineProperty({}, 'x', { enumerable: true, get() { invoked = true; return 'secret'; } });
  const inheritedHook = Object.create(Object.assign(Object.create(null), { toJSON() { invoked = true; return 'secret'; } }));
  const inheritedGetter = Object.setPrototypeOf([], Object.defineProperty(Object.create(Array.prototype), 'toJSON', {
    get() { invoked = true; return () => 'secret'; },
  }));
  const cyclic = {}; cyclic.self = cyclic;
  let deep = {}; for (let i = 0; i < 20; i++) deep = { deep };
  for (const value of [getter, inheritedHook, inheritedGetter, cyclic, deep, NaN, Infinity, undefined, 1n, new Date(), () => {}, Array(1),
    { toJSON() { invoked = true; return 'secret'; } }, JSON.parse('{"__proto__":{"danger":1}}'), { constructor: 'bad' }]) {
    assert.throws(() => boundedPythonJson(value), /PYTHON_INPUT_UNSAFE/);
  }
  assert.equal(invoked, false);
});
test('adapter: uses one sandbox invocation and existing workflow result/evidence contracts', async () => {
  let calls = 0;
  const execute = adapter(async (_permit, input) => {
    calls++;
    assert.equal(input.files['inputs.json'], '{"value":3}');
    assert.equal(Object.keys(input.files).length, 3);
    assert.match(input.files['test_testmind_script.py'], /runpy.run_path/);
    return result();
  });
  const output = await execute(context(), request());
  assert.equal(calls, 1);
  assert.equal(output.outputs.data.answer, 3);
  assert.equal(output.branch, 'success');
  assert.equal(core.validateValue('test.results', output.outputs.result), true);
  assert.equal(core.assessWorkflowEvidence([{ id: 'script', status: 'succeeded', testsRequired: true, evidence: output.evidence }]).passed, true);
});
test('adapter: authorization, approval, environment and limits reject before execution', async () => {
  let executed = 0;
  const execute = adapter(async () => { executed++; return result(); });
  for (const deny of [{ projectOwned: false }, { permissions: [] }, { environmentAllowed: false },
    { approvalGranted: false }, { withinLimits: false }]) {
    await assert.rejects(execute({ ...context(), authorize: async () => ({ ...allowed(), ...deny }) }, request()), /PYTHON_EXECUTION_UNAUTHORIZED/);
  }
  await assert.rejects(execute({ ...context(), authorize: async () => { throw new Error('private-credential'); } }, request()), /^Error: PYTHON_EXECUTION_UNAUTHORIZED$/);
  await assert.rejects(execute(context(), { ...request(), env: { HOST_SECRET: 'no' } }), /PYTHON_INPUT_UNSAFE/);
  await assert.rejects(execute(context(), { ...request(), script: 'synthetic-project-credential' }), /PYTHON_INPUT_UNSAFE/);
  await assert.rejects(execute({ ...context(), deadline: Date.now() - 1 }, request()), /deadline exceeded/);
  assert.equal(executed, 0);
});
test('adapter: permission revocation while running prevents returning data', async () => {
  let authorized = true;
  const execute = adapter(async () => { authorized = false; return result(); });
  await assert.rejects(execute({ ...context(), authorize: async () => ({ ...allowed(), projectOwned: authorized }) }, request()), /PYTHON_EXECUTION_UNAUTHORIZED/);
});
test('adapter: errors, skipped scripts, missing/malformed outputs and sensitive results never pass or leak', async () => {
  for (const fields of [
    { status: 'failed', message: 'synthetic-project-credential', scriptResult: { status: 'error' } },
    { status: 'failed', scriptResult: { status: 'assertion' } }, { status: 'skipped' }, { scriptResult: undefined },
    { scriptResult: { status: 'completed', json: 'bad JSON' } },
    { scriptResult: { status: 'completed', json: '"synthetic-project-credential"' } },
    { scriptResult: { status: 'completed', json: '{"password":"unknown-sensitive-value"}' } },
    { scriptResult: { status: 'completed', json: '{"constructor":"unsafe"}' } },
  ]) {
    const output = await adapter(async () => result(fields))(context(), request());
    assert.equal(output.branch, 'failure');
    assert.equal(output.outputs.data, null);
    assert.equal(output.outputs.result.qualityGate.passed, false);
    assert.equal(JSON.stringify(output).includes('credential'), false);
    assert.equal(JSON.stringify(output).includes('unknown-sensitive-value'), false);
  }
});
test('adapter: unavailable sandbox fails closed without fallback or retry', async () => {
  let calls = 0;
  await assert.rejects(adapter(async () => { calls++; throw new Error('PYTEST_SANDBOX_UNVERIFIED'); })(context(), request()), /PYTEST_SANDBOX_UNVERIFIED/);
  assert.equal(calls, 1);
});
test('JUnit: script properties are bounded, unambiguous and optional for ordinary pytest', () => {
  const xml = properties => `<testsuite><testcase classname="test_testmind_script" name="test_script"><properties>${properties}</properties></testcase></testsuite>`;
  const status = '<property name="testmind.python.status" value="completed"/>';
  const value = '<property name="testmind.python.result" value="{&quot;answer&quot;:3}"/>';
  const parsed = junit.parsePytestJUnit(xml(status + value));
  assert.equal(parsed.cases[0].scriptResult.json, '{"answer":3}');
  for (const properties of [status, value, status + status + value, status + value + value,
    status + '<property name="testmind.python.result" value="' + 'x'.repeat(65537) + '"/>']) {
    assert.equal(junit.parsePytestJUnit(xml(properties)).reportState, 'invalid');
  }
  assert.equal(junit.parsePytestJUnit(xml('<property name="unrelated" value="metadata"/>')).reportState, 'complete');
});
