import { randomUUID } from 'node:crypto';
import { execa } from 'execa';
import { normalizePytestJUnit } from './pytest-junit.js';

const MEMORY = 256 * 1024 * 1024;
const TMPFS = { '/work': 'rw,nosuid,nodev,noexec,size=64m,uid=65532,gid=65532,mode=700',
  '/tmp': 'rw,nosuid,nodev,noexec,size=16m,uid=65532,gid=65532,mode=700' };
const permits = new WeakSet<object>();
export interface VerifiedPytestSandbox { readonly imageId: string }
const fail = (code = 'PYTEST_SANDBOX_UNVERIFIED'): never => { throw new Error(code); };
// Explicit local endpoint; never inherit DOCKER_HOST or a remote Docker context.
const endpoint = process.platform === 'win32' ? 'npipe:////./pipe/docker_engine' : 'unix:///var/run/docker.sock';
const docker = (args: string[], timeout = 15_000) => execa('docker', ['--host', endpoint, ...args], {
  reject: false, timeout, maxBuffer: 6 * 1024 * 1024, windowsHide: true,
});
async function json(args: string[]) {
  const result = await docker(args);
  if (result.failed) fail();
  try { return JSON.parse(result.stdout); } catch { return fail(); }
}

/** Inspect actual Docker settings before any user code is sent to the container. */
export function assertPytestContainer(container: any, imageId: string) {
  const h = container?.HostConfig, c = container?.Config;
  const envKeys = new Set(['PATH', 'LANG', 'GPG_KEY', 'PYTHON_VERSION', 'PYTHON_SHA256',
    'PYTHONDONTWRITEBYTECODE', 'PYTEST_DISABLE_PLUGIN_AUTOLOAD']);
  if (!h || !c || container.Image !== imageId || c.User !== '65532:65532'
    || c.WorkingDir !== '/work' || JSON.stringify(c.Entrypoint) !== '["python"]'
    || JSON.stringify(c.Cmd) !== '["-I","/opt/testmind/supervisor.py"]'
    || !Array.isArray(c.Env) || c.Env.some((v: string) => !envKeys.has(v.split('=')[0]))
    || Object.keys(c.Volumes ?? {}).length || h.Privileged || !h.ReadonlyRootfs
    || h.NetworkMode !== 'none' || h.PidMode !== '' || h.IpcMode !== 'private' || h.CgroupnsMode !== 'private'
    || h.Memory !== MEMORY || h.MemorySwap !== MEMORY || h.PidsLimit !== 32
    || h.CpuPeriod !== 100_000 || h.CpuQuota !== 50_000
    || JSON.stringify(h.CapDrop) !== '["ALL"]' || (h.CapAdd ?? []).length
    || JSON.stringify(h.SecurityOpt) !== '["no-new-privileges=true"]'
    || (h.Binds ?? []).length || (h.VolumesFrom ?? []).length || (h.Devices ?? []).length
    || (h.DeviceRequests ?? []).length || (h.ExtraHosts ?? []).length
    || Object.keys(h.PortBindings ?? {}).length || h.PublishAllPorts
    || h.LogConfig?.Type !== 'none' || h.RestartPolicy?.Name !== 'no'
    || Object.keys(h.Tmpfs ?? {}).length !== 2 || Object.entries(TMPFS).some(([path, options]) => h.Tmpfs?.[path] !== options)
    || (container.Mounts ?? []).some((m: any) => m.Type !== 'tmpfs' || !Object.hasOwn(TMPFS, m.Destination))) fail();
  for (const [name, limit] of [['core', 0], ['fsize', 4194304], ['nofile', 128], ['cpu', 30]] as const) {
    if (!(h.Ulimits ?? []).some((u: any) => u.Name === name && u.Soft === limit && u.Hard === limit)) fail();
  }
}

function ready(message: any) {
  return message?.kind === 'ready' && message.protocol === 1 && message.isolated === true
    && message.limits?.['memory.max'] === String(MEMORY) && message.limits?.['memory.swap.max'] === '0'
    && message.limits?.['pids.max'] === '32' && message.limits?.['cpu.max'] === '50000 100000';
}

async function destroy(name: string) {
  // Only this invocation's random container name. Verify removal before reporting completion.
  const list = () => docker(['container', 'ls', '--all', '--filter', `name=^/${name}$`, '--format', '{{.ID}}']);
  const before = await list();
  if (before.failed) fail('PYTEST_SANDBOX_CLEANUP_FAILED');
  if (before.stdout.trim()) await docker(['rm', '--force', name]);
  const after = await list();
  if (after.failed || after.stdout.trim()) fail('PYTEST_SANDBOX_CLEANUP_FAILED');
}

async function exchange(imageId: string, job: object, timeoutMs: number, signal?: AbortSignal) {
  if (!/^sha256:[a-f0-9]{64}$/.test(imageId)) fail();
  const payload = `${JSON.stringify(job)}\n`;
  if (Buffer.byteLength(payload) > 1024 * 1024) fail('PYTEST_INPUT_INVALID');
  const name = `tm-pytest-${randomUUID()}`;
  let termination: 'timeout' | 'canceled' | undefined;
  let attempted = false;
  const checkAbort = () => { if (signal?.aborted) fail('PYTEST_CANCELED'); };
  try {
    checkAbort();
    const info = await json(['info', '--format', '{{json .}}']);
    if (info.OSType !== 'linux' || info.CgroupVersion !== '2'
      || !info.SecurityOptions?.includes('name=seccomp,profile=builtin')) fail();
    checkAbort();
    attempted = true;
    const created = await docker(['create', '--pull=never', '--name', name, '--label', 'testmind.pytest=1',
      '--interactive', '--network=none', '--read-only', '--user=65532:65532', '--workdir=/work',
      '--cap-drop=ALL', '--security-opt=no-new-privileges=true', '--ipc=private', '--cgroupns=private',
      '--memory=256m', '--memory-swap=256m', '--cpu-period=100000', '--cpu-quota=50000', '--pids-limit=32',
      '--ulimit=core=0:0', '--ulimit=fsize=4194304:4194304', '--ulimit=nofile=128:128', '--ulimit=cpu=30:30',
      '--tmpfs', `/work:${TMPFS['/work']}`, '--tmpfs', `/tmp:${TMPFS['/tmp']}`,
      '--log-driver=none', '--restart=no', '--no-healthcheck', '--entrypoint=python', imageId, '-I', '/opt/testmind/supervisor.py']);
    if (created.failed) fail();
    checkAbort();
    const [container] = await json(['inspect', name]);
    assertPytestContainer(container, imageId);
    checkAbort();
    const child = docker(['start', '--attach', '--interactive', name], timeoutMs + 20_000);
    let buffer = '', sent = false, protocolError = false, response: any;
    let stopping: Promise<void> | undefined, cleanupError: unknown;
    const stop = () => {
      stopping ??= destroy(name).catch(error => { cleanupError = error; });
    };
    const cancel = () => { termination = 'canceled'; stop(); };
    const timer = setTimeout(() => { termination ??= 'timeout'; stop(); }, timeoutMs + 5_000);
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', chunk => {
      buffer += chunk.toString();
      if (Buffer.byteLength(buffer) > 6 * 1024 * 1024) { protocolError = true; stop(); return; }
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        try {
          const message = JSON.parse(line);
          if (!sent && ready(message) && !termination) {
            sent = true;
            child.stdin?.end(payload);
          } else if (sent && !response && ['verified', 'result'].includes(message.kind)) response = message;
          else { protocolError = true; stop(); }
        } catch { protocolError = true; stop(); }
      }
    });
    try {
      const ended = await child;
      await stopping;
      if (cleanupError) fail('PYTEST_SANDBOX_CLEANUP_FAILED');
      if (termination) return { kind: 'result', termination, exitCode: null, xml: undefined };
      if (ended.failed || protocolError || buffer.trim() || !sent || !response) fail();
      return response;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
    }
  } catch (error) {
    if (signal?.aborted) return { kind: 'result', termination: 'canceled', exitCode: null, xml: undefined };
    // Docker errors may contain paths or diagnostics; return only fixed codes.
    if (error instanceof Error && error.message === 'PYTEST_SANDBOX_CLEANUP_FAILED') throw error;
    return fail();
  } finally {
    if (attempted) await destroy(name);
  }
}

/** No runnable workflow node or public endpoint exists. Only a verified immutable image earns a permit. */
export async function verifyPytestSandbox(imageId: string): Promise<VerifiedPytestSandbox> {
  const result = await exchange(imageId, { probe: true }, 5_000);
  if (result.kind !== 'verified') fail();
  const permit = Object.freeze({ imageId });
  permits.add(permit);
  return permit;
}

export async function runIsolatedPytest(permit: VerifiedPytestSandbox, input: {
  files: Record<string, string>; timeoutMs: number; signal?: AbortSignal;
}) {
  if (!permits.has(permit)) fail();
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 100 || input.timeoutMs > 30_000
    || !input.files || typeof input.files !== 'object' || Array.isArray(input.files)
    || !Object.keys(input.files).length || Object.keys(input.files).length > 100
    || Object.entries(input.files).some(([name, value]) => typeof value !== 'string' || name.length > 200
      || !/^[a-zA-Z0-9_./-]+$/.test(name) || name.split('/').some(part => ['', '.', '..'].includes(part)))) fail('PYTEST_INPUT_INVALID');
  const result = await exchange(permit.imageId, { files: input.files, timeoutMs: input.timeoutMs }, input.timeoutMs, input.signal);
  if (result.kind !== 'result' || (result.xml != null && typeof result.xml !== 'string')
    || (result.exitCode !== null && !Number.isInteger(result.exitCode))
    || (result.termination != null && !['timeout', 'canceled'].includes(result.termination))) fail();
  return normalizePytestJUnit(result.xml ?? undefined, { exitCode: result.exitCode, termination: result.termination ?? undefined });
}
