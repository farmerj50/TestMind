/**
 * Git capability — read-only and write git operations.
 *
 * Read-only actions (no approval needed): status, diff, log, show
 * Write actions (require approval before calling): commit, push, branch, reset
 *
 * The step-executor must gate approval for write actions before calling this.
 *
 * input.target = repo working directory path
 * input.params = action-specific options
 */

import { execa } from 'execa';
import type { CapabilityInput, CapabilityOutput, ExecutionContext } from './types.js';

/** Actions that mutate repo state and require prior approval */
export const GIT_WRITE_ACTIONS = new Set(['commit', 'push', 'branch', 'reset', 'checkout']);

const MAX_OUTPUT = 20_000;
function trunc(s: string) {
  return s.length > MAX_OUTPUT ? s.slice(0, MAX_OUTPUT) + '\n… (truncated)' : s;
}

async function git(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string; ok: boolean }> {
  const r = await execa('git', args, { cwd, reject: false, all: true });
  return {
    stdout: trunc(r.stdout ?? ''),
    stderr: trunc(r.stderr ?? ''),
    ok: (r.exitCode ?? 1) === 0,
  };
}

export async function runGitCapability(
  input: CapabilityInput,
  ctx: ExecutionContext,
): Promise<CapabilityOutput> {
  const cwd = input.target ?? ctx.workDir;
  if (!cwd) return { success: false, error: 'git capability requires a target directory path' };

  const params = (input.params ?? {}) as Record<string, unknown>;

  switch (input.action) {
    case 'status': {
      const r = await git(cwd, ['status', '--short', '--branch']);
      return { success: r.ok, data: { output: r.stdout }, error: r.ok ? undefined : r.stderr };
    }

    case 'diff': {
      const ref = (params.ref as string | undefined) ?? 'HEAD';
      const file = params.file as string | undefined;
      const args = ['diff', ref, '--stat', ...(file ? ['--', file] : [])];
      const r = await git(cwd, args);
      return { success: r.ok, data: { output: r.stdout }, error: r.ok ? undefined : r.stderr };
    }

    case 'log': {
      const n = Number(params.n ?? 10);
      const format = (params.format as string | undefined) ?? '%h %s (%an, %ar)';
      const r = await git(cwd, ['log', `--pretty=format:${format}`, `-${n}`]);
      const entries = r.stdout.split('\n').filter(Boolean);
      return { success: r.ok, data: { entries }, error: r.ok ? undefined : r.stderr };
    }

    case 'show': {
      const ref = (params.ref as string | undefined) ?? 'HEAD';
      const r = await git(cwd, ['show', '--stat', ref]);
      return { success: r.ok, data: { output: r.stdout }, error: r.ok ? undefined : r.stderr };
    }

    case 'commit': {
      const message = params.message as string | undefined;
      if (!message) return { success: false, error: 'git commit requires params.message' };
      const r = await git(cwd, ['commit', '-m', message]);
      return { success: r.ok, data: { output: r.stdout }, error: r.ok ? undefined : r.stderr };
    }

    case 'push': {
      const remote = (params.remote as string | undefined) ?? 'origin';
      const branch = params.branch as string | undefined;
      const args = ['push', remote, ...(branch ? [branch] : [])];
      const r = await git(cwd, args);
      return { success: r.ok, data: { output: r.stdout }, error: r.ok ? undefined : r.stderr };
    }

    case 'branch': {
      const name = params.name as string | undefined;
      if (!name) return { success: false, error: 'git branch requires params.name' };
      const r = await git(cwd, ['checkout', '-b', name]);
      return { success: r.ok, data: { output: r.stdout }, error: r.ok ? undefined : r.stderr };
    }

    case 'reset': {
      const mode = (params.mode as string | undefined) ?? '--soft';
      const ref = (params.ref as string | undefined) ?? 'HEAD~1';
      const r = await git(cwd, ['reset', mode, ref]);
      return { success: r.ok, data: { output: r.stdout }, error: r.ok ? undefined : r.stderr };
    }

    default:
      return { success: false, error: `Unknown git action: ${input.action}` };
  }
}
