/**
 * Step executor — creates and runs OperatorStep records through the capability dispatcher.
 *
 * Usage:
 *   const runner = createStepRunner(taskId, ctx);
 *   await runner.run('api',        { action: 'get',  target: 'https://app.example.com/health' });
 *   await runner.run('browser',    { action: 'navigate', target: 'https://app.example.com' });
 *   await runner.run('filesystem', { action: 'read', target: './report.json' });
 *
 * Each call persists an OperatorStep row and records output/status.
 * If abortOnFailure is set (default true) and the step fails, an error is thrown.
 */

import { prisma } from '../prisma.js';
import { dispatch, type CapabilityName, type CapabilityInput, type ExecutionContext } from './capabilities/index.js';
import { GIT_WRITE_ACTIONS } from './capabilities/git-cap.js';
import type { CapabilityOutput } from './capabilities/types.js';

/** Actions that require prior approval keyed by capability */
const APPROVAL_REQUIRED: Partial<Record<CapabilityName, Set<string>>> = {
  terminal: new Set(['run']),
  git: GIT_WRITE_ACTIONS,
  security: new Set(['*']), // all security actions
};

function needsApproval(capability: CapabilityName, action: string): boolean {
  const set = APPROVAL_REQUIRED[capability];
  if (!set) return false;
  return set.has('*') || set.has(action);
}

export interface StepRunnerOptions {
  /** When true (default), throw after a failed step instead of continuing */
  abortOnFailure?: boolean;
}

export interface StepResult {
  stepId: string;
  capability: CapabilityName;
  action: string;
  output: CapabilityOutput;
}

export function createStepRunner(
  taskId: string,
  ctx: ExecutionContext,
  opts: StepRunnerOptions = {},
) {
  const { abortOnFailure = true } = opts;
  let stepIdx = 0;

  /**
   * Execute a single capability step.
   * If the action requires approval, callers should call requestApproval()
   * from operator-worker.ts BEFORE calling this.
   */
  async function run(
    capability: CapabilityName,
    input: CapabilityInput,
    label?: string,
  ): Promise<StepResult> {
    const idx = stepIdx++;

    // Warn if a destructive action is run without going through approval.
    // In production the operator-worker should gate these; this is a dev guard.
    if (needsApproval(capability, input.action)) {
      console.warn(
        `[step-executor] capability=${capability} action=${input.action} requires approval — ` +
        `ensure requestApproval() was called before this step`,
      );
    }

    const step = await prisma.operatorStep.create({
      data: {
        taskId,
        idx,
        capability: capability as any,
        action: input.action,
        target: input.target ?? null,
        inputJson: (input.params ?? {}) as any,
        status: 'running',
        startedAt: new Date(),
      },
    });

    let output: CapabilityOutput;
    try {
      output = await dispatch(capability, input, ctx);
    } catch (err: any) {
      output = { success: false, error: err?.message ?? String(err) };
    }

    await prisma.operatorStep.update({
      where: { id: step.id },
      data: {
        status: output.success ? 'succeeded' : 'failed',
        finishedAt: new Date(),
        outputJson: { data: output.data, artifacts: output.artifacts } as any,
        error: output.error ?? null,
      },
    });

    console.log(
      `[step-executor] [${output.success ? 'ok' : 'FAIL'}] ` +
      `${capability}:${input.action} ${label ?? input.target ?? ''} (step ${idx})`,
    );

    if (!output.success && abortOnFailure) {
      throw new Error(
        `Step ${idx} failed (${capability}:${input.action}): ${output.error}`,
      );
    }

    return { stepId: step.id, capability, action: input.action, output };
  }

  return { run };
}

export type StepRunner = ReturnType<typeof createStepRunner>;
