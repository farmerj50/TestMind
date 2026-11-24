import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { loadTs } from './operator-harness.mjs';

const { assertPytestContainer, runIsolatedPytest, verifyPytestSandbox } = loadTs('apps/api/src/runner/pytest-sandbox.ts', {
  'node:crypto': crypto, execa: { execa() { throw new Error('Docker must not execute'); } }, './pytest-junit.js': {},
});
const imageId = `sha256:${'a'.repeat(64)}`;
const valid = () => ({ Image: imageId, Mounts: [], Config: { User: '65532:65532', WorkingDir: '/work', Entrypoint: ['python'],
  Cmd: ['-I', '/opt/testmind/supervisor.py'], Env: ['PATH=/usr/bin'], Volumes: null }, HostConfig: {
  ReadonlyRootfs: true, NetworkMode: 'none', PidMode: '', IpcMode: 'private', CgroupnsMode: 'private',
  Memory: 268435456, MemorySwap: 268435456, PidsLimit: 32, CpuPeriod: 100000, CpuQuota: 50000,
  CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges=true'], LogConfig: { Type: 'none' }, RestartPolicy: { Name: 'no' },
  Tmpfs: { '/work': 'rw,nosuid,nodev,noexec,size=64m,uid=65532,gid=65532,mode=700', '/tmp': 'rw,nosuid,nodev,noexec,size=16m,uid=65532,gid=65532,mode=700' },
  Ulimits: [['core', 0], ['fsize', 4194304], ['nofile', 128], ['cpu', 30]].map(([Name, limit]) => ({ Name, Soft: limit, Hard: limit })),
} });
test('sandbox: inspected restrictions accept only the bounded profile', () => {
  assert.doesNotThrow(() => assertPytestContainer(valid(), imageId));
  for (const change of [c => c.Image = 'tag:latest', c => c.Config.User = '0', c => c.Config.Env.push('HOST_SECRET=synthetic'),
    c => c.Config.Cmd = ['-c', 'arbitrary'], c => c.HostConfig.Privileged = true, c => c.HostConfig.ReadonlyRootfs = false,
    c => c.HostConfig.NetworkMode = 'host', c => c.HostConfig.PidMode = 'host', c => c.HostConfig.IpcMode = 'host',
    c => c.HostConfig.CgroupnsMode = 'host', c => c.HostConfig.Memory = 0, c => c.HostConfig.MemorySwap = -1,
    c => c.HostConfig.PidsLimit = -1, c => c.HostConfig.CpuQuota = 0, c => c.HostConfig.CapAdd = ['SYS_ADMIN'],
    c => c.HostConfig.SecurityOpt = ['seccomp=unconfined'], c => c.HostConfig.Binds = ['/host:/data'],
    c => c.Mounts = [{ Type: 'bind', Destination: '/host' }], c => c.HostConfig.LogConfig.Type = 'json-file',
    c => c.HostConfig.RestartPolicy.Name = 'always', c => c.HostConfig.Ulimits = [], c => c.HostConfig.Tmpfs['/work'] = 'size=1g']) {
    const container = valid(); change(container);
    assert.throws(() => assertPytestContainer(container, imageId), /PYTEST_SANDBOX_UNVERIFIED/);
  }
});
test('sandbox: forged permits, mutable tags and unavailable isolation never execute pytest', async () => {
  await assert.rejects(runIsolatedPytest({ imageId }, { files: { 'test_ok.py': '' }, timeoutMs: 1000 }), /PYTEST_SANDBOX_UNVERIFIED/);
  await assert.rejects(verifyPytestSandbox('python:latest'), /PYTEST_SANDBOX_UNVERIFIED/);
  await assert.rejects(verifyPytestSandbox(imageId), /PYTEST_SANDBOX_UNVERIFIED/);
});
