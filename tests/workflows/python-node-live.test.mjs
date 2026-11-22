import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createRequire } from 'node:module';
import * as sandbox from '../../apps/api/src/runner/pytest-sandbox.ts';
import * as scriptAdapter from '../../apps/api/src/runner/python-script.ts';
import { pythonGraph, pythonNodeHarness } from './python-node-harness.mjs';
const require = createRequire(new URL('../../apps/api/package.json', import.meta.url));
const Fastify = require('fastify');
const endpoint = process.platform === 'win32' ? 'npipe:////./pipe/docker_engine' : 'unix:///var/run/docker.sock';
const docker = args => execFileSync('docker', ['--host', endpoint, ...args], { encoding: 'utf8', windowsHide: true, timeout: 15000 }).trim();
const imageId = docker(['image', 'inspect', 'testmind/pytest-r2-task2:local', '--format', '{{.Id}}']);
const fixture = graph => pythonNodeHarness({ sandbox, scriptAdapter, imageId, graph });
const clean = () => assert.equal(docker(['ps', '--all', '--filter', 'label=testmind.pytest=1', '--format', '{{.ID}}']), '');

test('Python node live: graph executes script, binds outputs, verifies assertions and reports once', async () => {
  const h = fixture(pythonGraph());
  assert.equal((await h.finish()).status, 'succeeded');
  assert.equal(h.rows.find(row => row.nodeKey === 'check').status, 'succeeded');
  assert.equal(h.rows.find(row => row.nodeKey === 'report').outputJson.outputs.result.outcome, 'passed');
  assert.equal(h.rows.find(row => row.nodeKey === 'python').outputJson.outputs.data.answer, 4);
  const count = h.rows.length; await h.tick(); assert.equal(h.rows.length, count);
  clean();
});
test('Python node live: assertion failure and timeout retain failing terminal evidence', async () => {
  for (const [source, timeout, kind] of [['def main(inputs):\n    assert False, "private-diagnostic"', 10000, 'assertion'],
    ['import time\ndef main(inputs):\n    time.sleep(60)', 1000, 'timeout']]) {
    const h = fixture(pythonGraph(source, timeout));
    assert.equal((await h.finish()).status, 'failed');
    const row = h.rows.find(row => row.nodeKey === 'python');
    assert.equal(row.status, 'failed'); assert.equal(row.outputJson.failureKind, kind);
    assert.equal(row.outputJson.outputs.result.qualityGate.passed, false);
    assert.equal(JSON.stringify(h.rows.map(row => [row.inputJson, row.outputJson, row.error])).includes('private-diagnostic'), false);
    clean();
  }
});
test('Python node live: API cancellation stops active script and detached child, records canceled state', async () => {
  const h = fixture(pythonGraph('import subprocess, sys, time\ndef main(inputs):\n    subprocess.Popen([sys.executable,"-c","import time; time.sleep(60)"], start_new_session=True)\n    time.sleep(60)', 30000));
  const app = Fastify(); await h.routes.workflowGraphRoutes(app);
  await h.tick();
  const running = h.tick();
  try {
    let active = false; const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const id = docker(['ps', '--filter', 'label=testmind.pytest=1', '--format', '{{.ID}}']);
      if (id) {
        const processes = docker(['top', id, '-eo', 'pid,args']);
        if (processes.includes('-m pytest') && processes.includes('import time; time.sleep(60)')) { active = true; break; }
      }
      await delay(100);
    }
    assert.ok(active, 'Cancellation must target active code and child');
    const response = await app.inject({ method: 'POST', url: '/workflows/runs/run/cancel', headers: { 'x-user-id': 'owner' } });
    assert.equal(response.statusCode, 200);
    assert.equal((await running).status, 'canceled');
    assert.equal(h.run.status, 'canceled');
    assert.equal(h.rows.find(row => row.nodeKey === 'python').outputJson.failureKind, 'canceled');
    const count = h.rows.length; await h.tick(); assert.equal(h.rows.length, count);
    clean();
  } finally { h.run.status = 'canceled'; await running.catch(() => {}); await app.close(); }
});
test('Python node live: confirmed failure retries through existing API once with accurate history', async () => {
  const h = fixture(pythonGraph()); delete h.env.TM_PYTHON_WORKFLOWS_ENABLED;
  assert.equal((await h.finish()).status, 'failed');
  const first = h.rows.find(row => row.nodeKey === 'python'); assert.match(first.error, /PYTHON_WORKFLOWS_DISABLED/);
  h.env.TM_PYTHON_WORKFLOWS_ENABLED = '1';
  const app = Fastify(); await h.routes.workflowGraphRoutes(app);
  try {
    const url = '/workflows/runs/run/nodes/python/retry';
    assert.equal((await app.inject({ method: 'POST', url, headers: { 'x-user-id': 'foreign' } })).statusCode, 404);
    const attempts = await Promise.all([1, 2].map(() => app.inject({ method: 'POST', url, headers: { 'x-user-id': 'owner' } })));
    assert.deepEqual(attempts.map(response => response.statusCode).sort(), [200, 409]);
    assert.equal(h.dispatches, 1);
    assert.equal((await h.finish()).status, 'succeeded');
    const history = h.rows.filter(row => row.nodeKey === 'python');
    assert.equal(history.length, 2); assert.equal(history[0].status, 'failed'); assert.equal(history[1].status, 'succeeded');
    assert.equal(history[1].nodeAttempt, 2);
    const count = h.rows.length; await h.tick(); assert.equal(h.rows.length, count);
    const detail = await app.inject({ url: '/workflows/runs/run', headers: { 'x-user-id': 'owner' } });
    assert.equal(detail.json().tasks.filter(task => task.nodeKey === 'python').length, 2);
    assert.equal(detail.json().run.status, 'succeeded');
    clean();
  } finally { await app.close(); }
});
test('Python node live: unavailable pinned image and secret-bearing inputs fail closed', async () => {
  const unavailable = fixture(pythonGraph()); unavailable.env.TM_PYTHON_SANDBOX_IMAGE = `sha256:${'f'.repeat(64)}`;
  assert.equal((await unavailable.finish()).status, 'failed');
  assert.match(unavailable.rows.find(row => row.nodeKey === 'python').error, /PYTEST_SANDBOX_UNVERIFIED/);
  const secret = fixture(pythonGraph()); secret.addSecret('known-project-private-975');
  secret.graph.nodes[1].inputs.values.value = { value: 'known-project-private-975' };
  assert.equal((await secret.finish()).status, 'failed');
  assert.match(secret.rows.find(row => row.nodeKey === 'python').error, /PYTHON_INPUT_UNSAFE/);
  assert.equal(JSON.stringify(secret.rows.map(row => [row.inputJson, row.outputJson, row.error])).includes('known-project-private-975'), false);
  clean();
});
