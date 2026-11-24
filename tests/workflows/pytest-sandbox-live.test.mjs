import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { verifyPytestSandbox, runIsolatedPytest } from '../../apps/api/src/runner/pytest-sandbox.ts';

const endpoint = process.platform === 'win32' ? 'npipe:////./pipe/docker_engine' : 'unix:///var/run/docker.sock';
const docker = args => execFileSync('docker', ['--host', endpoint, ...args], { encoding: 'utf8', windowsHide: true, timeout: 15000 }).trim();
const imageId = docker(['image', 'inspect', 'testmind/pytest-r2-task2:local', '--format', '{{.Id}}']);
let permit;
const clean = () => assert.equal(docker(['ps', '--all', '--filter', 'label=testmind.pytest=1', '--format', '{{.ID}}']), '', 'No owned sandbox or descendant lifecycle may remain');

test('live sandbox: immutable image passes trusted preflight before any pytest code', async () => {
  permit = await verifyPytestSandbox(imageId);
  assert.equal(permit.imageId, imageId);
  clean();
});

test('live sandbox: actual resource enforcement, filesystem/network isolation, secrets and orphan cleanup', async () => {
  assert.ok(permit, 'Isolation preflight must pass first');
  process.env.TESTMIND_SYNTHETIC_HOST_SECRET = 'never-forward-this-synthetic-value';
  try {
    const result = await runIsolatedPytest(permit, { timeoutMs: 30000, files: { 'test_isolation.py': `
import errno, os, pathlib, resource, socket, subprocess, sys, time
import pytest

def test_host_secrets_and_filesystem():
    assert 'TESTMIND_SYNTHETIC_HOST_SECRET' not in os.environ
    assert not pathlib.Path('/var/run/docker.sock').exists()
    assert not pathlib.Path('/host').exists()
    with pytest.raises(OSError):
        pathlib.Path('/etc/forbidden-testmind').write_text('no')
    with pytest.raises(OSError):
        pathlib.Path('/sys/fs/cgroup/pids.max').write_text('max')
    status = dict(line.split(':', 1) for line in pathlib.Path('/proc/self/status').read_text().splitlines())
    assert int(status['CapEff'].strip(), 16) == 0
    assert status['NoNewPrivs'].strip() == '1' and status['Seccomp'].strip() == '2'

@pytest.mark.parametrize('address', ['1.1.1.1', '169.254.169.254', '127.0.0.1'])
def test_network_denied(address):
    with socket.socket() as connection:
        connection.settimeout(0.2)
        with pytest.raises(OSError):
            connection.connect((address, 443))

def test_process_limit():
    children = []
    try:
        with pytest.raises(OSError):
            for _ in range(40):
                children.append(subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(10)']))
        assert len(children) < 32
    finally:
        for child in children: child.kill()
        for child in children: child.wait()

def test_memory_limit():
    child = subprocess.run([sys.executable, '-c', 'data = bytearray(512 * 1024 * 1024)'])
    assert child.returncode < 0
    events = dict(line.split() for line in pathlib.Path('/sys/fs/cgroup/memory.events').read_text().splitlines())
    assert int(events['oom_kill']) >= 1

def test_cpu_and_file_limits():
    start = time.process_time()
    while time.process_time() - start < 0.4: pass
    stats = dict(line.split() for line in pathlib.Path('/sys/fs/cgroup/cpu.stat').read_text().splitlines())
    assert int(stats['nr_throttled']) > 0
    assert resource.getrlimit(resource.RLIMIT_FSIZE)[1] == 4194304
    with pytest.raises(OSError):
        with open('/work/oversized', 'wb') as stream: stream.write(b'x' * 5000000)

def test_detached_descendant_is_contained():
    subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'], start_new_session=True)
` } });
    assert.equal(result.outcome, 'passed', JSON.stringify({ outcome: result.outcome, cases: result.cases.map(c => ({ name: c.fullName, status: c.status, message: c.message })) }));
    assert.equal(result.evidence.counts.passed, 8);
    clean();
  } finally { delete process.env.TESTMIND_SYNTHETIC_HOST_SECRET; }
});

test('live sandbox: real pytest collection errors normalize without false success', async () => {
  assert.ok(permit);
  const result = await runIsolatedPytest(permit, { timeoutMs: 10000, files: { 'test_broken.py': 'def invalid syntax\n' } });
  assert.equal(result.outcome, 'collection-error');
  assert.equal(result.quality.passed, false);
  clean();
});

test('live sandbox: timeout kills owned subprocesses and records failure', async () => {
  assert.ok(permit);
  const result = await runIsolatedPytest(permit, { timeoutMs: 1000, files: { 'test_timeout.py': 'import time\ndef test_wait():\n    time.sleep(60)\n' } });
  assert.equal(result.outcome, 'timeout');
  assert.equal(result.quality.passed, false);
  clean();
});

test('live sandbox: cancel active pytest and its detached child before returning', async () => {
  assert.ok(permit);
  const controller = new AbortController();
  const running = runIsolatedPytest(permit, { timeoutMs: 30000, signal: controller.signal, files: { 'test_cancel.py':
    'import subprocess, sys, time\ndef test_cancel():\n    subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"], start_new_session=True)\n    time.sleep(60)\n' } });
  // Observe both live pytest and its child; cancellation of merely queued work is insufficient.
  try {
    let active = false;
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const ids = docker(['ps', '--filter', 'label=testmind.pytest=1', '--format', '{{.ID}}']);
      if (ids) {
        const processes = docker(['top', ids, '-eo', 'pid,args']);
        if (processes.includes('-m pytest') && processes.includes('import time; time.sleep(60)')) { active = true; break; }
      }
      await delay(100);
    }
    assert.equal(active, true, 'Expected active pytest and detached child before cancel');
    const started = Date.now();
    controller.abort();
    const result = await running;
    assert.equal(result.outcome, 'canceled');
    assert.equal(result.quality.passed, false);
    assert.ok(Date.now() - started < 10000, 'Cancellation must complete promptly');
    clean();
  } finally { controller.abort(); await running.catch(() => {}); }
});

test('live sandbox: rejected inputs and pre-canceled jobs have no execution or retry side effects', async () => {
  assert.ok(permit);
  for (const files of [{ '../host.py': '' }, { '/absolute.py': '' }, { 'ok.py': 'x'.repeat(1024 * 1024) }]) {
    await assert.rejects(runIsolatedPytest(permit, { timeoutMs: 1000, files }), /PYTEST_INPUT_INVALID/);
  }
  const controller = new AbortController(); controller.abort();
  const result = await runIsolatedPytest(permit, { timeoutMs: 1000, files: { 'test_never.py': 'raise AssertionError("must not run")' }, signal: controller.signal });
  assert.equal(result.outcome, 'canceled');
  clean();
});
