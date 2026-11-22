import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { verifyPytestSandbox } from '../../apps/api/src/runner/pytest-sandbox.ts';
import { executePythonScript } from '../../apps/api/src/runner/python-script.ts';

const endpoint = process.platform === 'win32' ? 'npipe:////./pipe/docker_engine' : 'unix:///var/run/docker.sock';
const docker = args => execFileSync('docker', ['--host', endpoint, ...args], { encoding: 'utf8', windowsHide: true, timeout: 15000 }).trim();
const imageId = docker(['image', 'inspect', 'testmind/pytest-r2-task2:local', '--format', '{{.Id}}']);
let permit;
const context = signal => ({ sandbox: permit, autonomy: 'assisted', signal: signal ?? new AbortController().signal,
  deadline: Date.now() + 40000, secretValues: ['synthetic-project-credential'], authorize: async () => ({
    projectOwned: true, permissions: ['workflow:execute'], environmentAllowed: true, approvalRequired: true, approvalGranted: true, withinLimits: true,
  }) });
const request = script => ({ script, declarations: {}, inputs: {}, timeoutMs: 15000 });
const clean = () => assert.equal(docker(['ps', '--all', '--filter', 'label=testmind.pytest=1', '--format', '{{.ID}}']), '');

test('script live: verify existing sandbox, declared inputs/files and structured JUnit output', async () => {
  permit = await verifyPytestSandbox(imageId);
  process.env.TESTMIND_SCRIPT_HOST_ONLY = 'synthetic-host-only-value';
  try {
    const result = await executePythonScript(context(), { ...request(`import os, pathlib
def main(inputs):
    assert 'TESTMIND_SCRIPT_HOST_ONLY' not in os.environ
    assert not pathlib.Path('/var/run/docker.sock').exists()
    pathlib.Path('/work/previous_execution').write_text('temporary')
    return {'answer': inputs['value'] + 1, 'text': pathlib.Path('inputs/note.txt').read_text(), 'keys': sorted(inputs)}
`), declarations: { value: { type: 'number', required: true }, note: { type: 'string', required: true, path: 'inputs/note.txt' },
      optional: { type: 'boolean', required: false } }, inputs: { value: 41, note: 'declared-text' } });
    assert.equal(result.outcome, 'passed');
    assert.deepEqual(result.outputs.data, { answer: 42, text: 'declared-text', keys: ['note', 'value'] });
    assert.equal(result.outputs.result.qualityGate.passed, true);
    assert.equal(result.evidence.counts.passed, 1);
    clean();
  } finally { delete process.env.TESTMIND_SCRIPT_HOST_ONLY; }
});

test('script live: concurrent invocations isolate inputs, files and previous execution state', async () => {
  assert.ok(permit);
  const script = `import pathlib, time, socket
def main(inputs):
    assert not pathlib.Path('/work/previous_execution').exists()
    pathlib.Path('/work/own_value').write_text(inputs['value'])
    time.sleep(0.2)
    with socket.socket() as connection:
        connection.settimeout(0.2)
        try:
            connection.connect(('169.254.169.254', 80))
        except OSError:
            pass
        else:
            raise AssertionError('unexpected network access')
    return {'value': pathlib.Path('/work/own_value').read_text()}
`;
  const results = await Promise.all(['first-input', 'second-input'].map(value => executePythonScript(context(), {
    ...request(script), declarations: { value: { type: 'string', required: true } }, inputs: { value },
  })));
  assert.deepEqual(results.map(result => result.outputs.data?.value), ['first-input', 'second-input']);
  assert.ok(results.every(result => result.outcome === 'passed'));
  clean();
});

test('script live: runtime errors and sensitive structured outputs fail without diagnostic exposure', async () => {
  assert.ok(permit);
  for (const script of ['def main(inputs):\n    raise ValueError("private-runtime-diagnostic")\n',
    'def main(inputs):\n    return {"pass" + "word": "private-runtime-diagnostic"}\n']) {
    const result = await executePythonScript(context(), request(script));
    assert.equal(result.outcome, 'error');
    assert.equal(result.outputs.data, null);
    assert.equal(result.outputs.result.qualityGate.passed, false);
    assert.equal(JSON.stringify(result).includes('private-runtime-diagnostic'), false);
    clean();
  }
});

test('script live: script assertions retain failure evidence', async () => {
  assert.ok(permit);
  const result = await executePythonScript(context(), request('def main(inputs):\n    assert False, "private-assertion-diagnostic"\n'));
  assert.equal(result.outcome, 'failed');
  assert.equal(result.failureKind, 'assertion');
  assert.equal(result.evidence.counts.failed, 1);
  assert.equal(JSON.stringify(result).includes('private-assertion-diagnostic'), false);
  clean();
});

test('script live: timeout fails after sandbox process cleanup', async () => {
  assert.ok(permit);
  const result = await executePythonScript(context(), { ...request('import time\ndef main(inputs):\n    time.sleep(60)\n'), timeoutMs: 1000 });
  assert.equal(result.outcome, 'error');
  assert.equal(result.failureKind, 'timeout');
  assert.equal(result.outputs.result.qualityGate.passed, false);
  clean();
});

test('script live: cancellation stops active execution and detached subprocesses', async () => {
  assert.ok(permit);
  const controller = new AbortController();
  const running = executePythonScript(context(controller.signal), { ...request(`import subprocess, sys, time
def main(inputs):
    subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'], start_new_session=True)
    time.sleep(60)
`), timeoutMs: 30000 });
  try {
    let active = false;
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const id = docker(['ps', '--filter', 'label=testmind.pytest=1', '--format', '{{.ID}}']);
      if (id) {
        const processes = docker(['top', id, '-eo', 'pid,args']);
        if (processes.includes('-m pytest') && processes.includes('import time; time.sleep(60)')) { active = true; break; }
      }
      await delay(100);
    }
    assert.equal(active, true, 'Cancellation must target an active script and child');
    const started = Date.now();
    controller.abort();
    const result = await running;
    assert.equal(result.outcome, 'error');
    assert.equal(result.failureKind, 'canceled');
    assert.equal(result.evidence.status, 'canceled');
    assert.ok(Date.now() - started < 10000);
    clean();
  } finally { controller.abort(); await running.catch(() => {}); }
});

test('script live: invalid sandbox permit cannot execute through the adapter', async () => {
  await assert.rejects(executePythonScript({ ...context(), sandbox: { imageId } }, request('def main(inputs):\n    return 1')), /PYTEST_SANDBOX_UNVERIFIED/);
  clean();
});
