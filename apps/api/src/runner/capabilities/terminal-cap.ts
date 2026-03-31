/**
 * Terminal capability — execute shell commands via execa.
 *
 * ALL terminal actions require prior approval (run_terminal).
 * This executor does NOT check approval itself — the step-executor
 * must gate approval before calling this.
 *
 * Supported actions: run
 *
 * input.target = command string (e.g. "npm test")
 * input.params = { args?: string[], cwd?, env?, timeoutMs? }
 */

import { execa } from 'execa';
import type { CapabilityInput, CapabilityOutput, ExecutionContext } from './types.js';

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 50_000;

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n… (truncated ${s.length - max} bytes)`;
}

export async function runTerminalCapability(
  input: CapabilityInput,
  ctx: ExecutionContext,
): Promise<CapabilityOutput> {
  if (input.action !== 'run') {
    return { success: false, error: `Unknown terminal action: ${input.action}` };
  }

  const command = input.target;
  if (!command) return { success: false, error: 'terminal capability requires a target command' };

  const params = (input.params ?? {}) as Record<string, unknown>;
  const cwd = (params.cwd as string | undefined) ?? ctx.workDir ?? process.cwd();
  const extraEnv = (params.env ?? {}) as Record<string, string>;
  const timeoutMs = Number(params.timeout ?? DEFAULT_TIMEOUT_MS);
  const args = (params.args ?? []) as string[];

  const [bin, ...defaultArgs] = command.split(/\s+/);
  const allArgs = [...defaultArgs, ...args];

  try {
    const result = await execa(bin, allArgs, {
      cwd,
      env: { ...process.env, ...extraEnv },
      timeout: timeoutMs,
      reject: false,
      all: true,
    });

    const stdout = truncate(result.stdout ?? '', MAX_OUTPUT_BYTES);
    const stderr = truncate(result.stderr ?? '', MAX_OUTPUT_BYTES);
    const exitCode = result.exitCode ?? 0;
    const success = exitCode === 0;

    return {
      success,
      data: { exitCode, stdout, stderr, command, args: allArgs, cwd },
      error: success ? undefined : `Command exited with code ${exitCode}`,
    };
  } catch (err: any) {
    return { success: false, error: err?.message ?? String(err) };
  }
}
