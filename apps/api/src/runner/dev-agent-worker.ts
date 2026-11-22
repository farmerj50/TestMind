import { execa } from "execa";
import { prisma } from "../prisma.js";
import { createDevAgentWorktree, removeDevAgentWorktree } from "./dev-agent-worktree.js";
import { canAffordNextStep, CONSERVATIVE_LLM_STEP_ESTIMATE_USD, callOpenAiAndTrackCost, resolveRealOpenAiClient } from "./dev-agent-budget.js";
import { applyFileOps, commitChanges, parseFileOps } from "./dev-agent-apply.js";
import { snippet } from "../security/redaction.js";

const TICK_DELAY_MS = 2000;
const PAUSE_RECHECK_MS = 5000;
const MAX_TEST_OUTPUT_CHARS = 4000;

type OpJobCtx = { id: string; projectId: string; type: string; requestedBy: string | null };
type ReDelayFn = (ms: number, phase: { kind: "dev_agent_iterate"; devAgentRunId: string }) => Promise<never>;

export type RequestApprovalFn = (opts: {
  jobId: string;
  taskId: string;
  requestedBy: string;
  actionType: "run_terminal" | "git_push" | "patch_code" | "security_active_test";
  description: string;
  context?: Record<string, unknown>;
  timeoutMs?: number;
}) => Promise<"approved">;

export type CodePhaseResult = { summary: string; filesChanged: import("./dev-agent-apply.js").AppliedFileChange[]; costUsd: number };
export type CodePhaseFn = (ctx: { run: any; iterationNumber: number; worktreePath: string }) => Promise<CodePhaseResult>;

export type TestCommandResult = { passed: boolean; output: string };
export type RunTestCommandFn = (worktreePath: string, command: string, devAgentRunId: string) => Promise<TestCommandResult>;

export type DevAgentDeps = {
  requestApproval?: RequestApprovalFn;
  codePhase?: CodePhaseFn;
  runTestCommand?: RunTestCommandFn;
};

// Default "code" phase: a real LLM call via the budget-tracked path, whose response is
// now actually applied as real file writes/deletes in the worktree and committed on the
// run's own branch - closing the gap the prior stage flagged (cost-tracked LLM call existed,
// but nothing was written to disk). The contract (dev-agent-apply.ts's FileOp[]) is enforced
// strictly: a malformed or path-unsafe response throws (InvalidFileOpsError) rather than
// silently doing nothing or writing something unsafe - advanceDevAgentJob below treats that
// the same as any other code-phase failure: fail closed, record the attempt, don't retry blindly.
const CODE_PHASE_SYSTEM_PROMPT = [
  "You are an autonomous coding agent working in an isolated git worktree.",
  'Respond with ONLY a JSON array of file operations, no prose, no markdown fence: [{"path":"relative/path.ts","action":"create"|"modify"|"delete","content":"...full file content, required for create/modify..."}]',
  "Paths must be relative to the repo root and must never contain '..' or start with '/'.",
].join(" ");

const defaultCodePhase: CodePhaseFn = async ({ run, iterationNumber, worktreePath }) => {
  const client = await resolveRealOpenAiClient(run.projectId);
  const result = await callOpenAiAndTrackCost({
    devAgentRunId: run.id,
    client,
    systemPrompt: CODE_PHASE_SYSTEM_PROMPT,
    userPrompt: `Instruction: ${run.instructionText ?? "(self-improvement mode: find and fix an issue)"}\nIteration: ${iterationNumber}`,
  });

  const ops = parseFileOps(result.content);
  const filesChanged = await applyFileOps(worktreePath, ops);
  await commitChanges(worktreePath, `dev-agent: iteration ${iterationNumber} - ${snippet(ops.map(o => `${o.action} ${o.path}`).join(", "), 200)}`);

  return { summary: snippet(result.content, 2000), filesChanged, costUsd: result.costUsd };
};

export const runConfiguredTestCommand: RunTestCommandFn = async (worktreePath, command, devAgentRunId) => {
  const [cmd, ...args] = command.split(" ");
  const subprocess = execa(cmd, args, { cwd: worktreePath, reject: false, all: true });

  // Item 5 (approved plan): emergency stop must SIGKILL an in-flight subprocess
  // immediately, not wait for the next tick boundary - this is the one place instant
  // termination is warranted, since it's a local subprocess we directly control.
  const pollId = setInterval(async () => {
    const current = await prisma.devAgentRun.findUnique({ where: { id: devAgentRunId }, select: { status: true } }).catch(() => null);
    if (current?.status === "canceled") subprocess.kill("SIGKILL");
  }, 1000);

  try {
    const result = await subprocess;
    return { passed: result.exitCode === 0, output: snippet(result.all ?? "", MAX_TEST_OUTPUT_CHARS) };
  } finally {
    clearInterval(pollId);
  }
};

async function getRealRequestApproval(): Promise<RequestApprovalFn> {
  const mod = await import("./operator-worker.js");
  return mod.requestApproval;
}

export async function advanceDevAgentJob(opJob: OpJobCtx, reDelay: ReDelayFn, deps: DevAgentDeps = {}): Promise<void> {
  const run = await prisma.devAgentRun.findFirst({ where: { operatorJobId: opJob.id } });
  if (!run) throw new Error(`DevAgentRun not found for OperatorJob ${opJob.id}`);

  const freshStatus = await prisma.devAgentRun.findUnique({ where: { id: run.id }, select: { status: true } });
  if (!freshStatus || freshStatus.status === "canceled") return;
  if (freshStatus.status === "paused") {
    await reDelay(PAUSE_RECHECK_MS, { kind: "dev_agent_iterate", devAgentRunId: run.id });
    return;
  }

  // One-time gate (correction #3): fail-closed authorization before autonomous code
  // execution is enabled for this run at all - not a per-iteration/per-action gate.
  if (run.status === "queued") {
    await prisma.devAgentRun.update({ where: { id: run.id }, data: { status: "awaitingApproval" } });
    const requestApprovalFn = deps.requestApproval ?? (await getRealRequestApproval());
    try {
      await requestApprovalFn({
        jobId: opJob.id,
        taskId: opJob.id,
        requestedBy: opJob.requestedBy ?? "system",
        actionType: "patch_code",
        description: `Enable autonomous code execution for DevAgentRun ${run.id} (target: ${run.targetRepo})`,
      });
    } catch (err: any) {
      await prisma.devAgentRun.update({
        where: { id: run.id },
        data: { status: "failed", finishedAt: new Date(), error: `Autonomous code execution not authorized: ${snippet(err?.message ?? String(err))}` },
      });
      throw err;
    }

    const worktree = await createDevAgentWorktree({ id: run.id, targetRepo: run.targetRepo });
    await prisma.devAgentRun.update({
      where: { id: run.id },
      data: { status: "running", startedAt: new Date(), worktreePath: worktree.path, workBranch: worktree.branch },
    });
  }

  const current = await prisma.devAgentRun.findUnique({ where: { id: run.id } });
  if (!current || current.status !== "running") return;

  const iterationCount = await prisma.devAgentIteration.count({ where: { devAgentRunId: run.id } });
  if (iterationCount >= current.maxIterations) {
    await prisma.devAgentRun.update({
      where: { id: run.id },
      data: { status: "failed", finishedAt: new Date(), error: "Max iterations reached without passing tests" },
    });
    await removeDevAgentWorktree(current);
    return;
  }

  // Correction #2: budget checked BEFORE the expensive operation, not only after.
  if (!canAffordNextStep(current, CONSERVATIVE_LLM_STEP_ESTIMATE_USD)) {
    await prisma.devAgentRun.update({
      where: { id: run.id },
      data: { status: "failed", finishedAt: new Date(), error: "Budget exceeded before next iteration" },
    });
    await removeDevAgentWorktree(current);
    return;
  }

  const iterationNumber = iterationCount + 1;
  const codePhase = deps.codePhase ?? defaultCodePhase;
  let codeResult: CodePhaseResult;
  try {
    codeResult = await codePhase({ run: current, iterationNumber, worktreePath: current.worktreePath! });
  } catch (err: any) {
    // Fail closed: an invalid/unsafe code-phase response (malformed JSON, path traversal,
    // or any other thrown error) must never be silently skipped. Record what happened and
    // stop this run rather than retrying blindly against a model that just produced an
    // unsafe response.
    const message = snippet(err?.message ?? String(err), 1000);
    await prisma.devAgentIteration.create({
      data: { devAgentRunId: run.id, iterationNumber, phase: "code", summary: `Code phase failed: ${message}`, filesChanged: [], testResult: { passed: false, output: message }, costUsd: 0 },
    });
    await prisma.devAgentRun.update({
      where: { id: run.id },
      data: { status: "failed", finishedAt: new Date(), error: `Code phase failed: ${message}` },
    });
    await removeDevAgentWorktree(current);
    return;
  }

  const runTestCommand = deps.runTestCommand ?? runConfiguredTestCommand;
  const testResult = current.testCommand
    ? await runTestCommand(current.worktreePath!, current.testCommand, run.id)
    : { passed: true, output: "(no test command configured for this run)" };

  await prisma.devAgentIteration.create({
    data: {
      devAgentRunId: run.id,
      iterationNumber,
      phase: "code",
      summary: codeResult.summary,
      filesChanged: codeResult.filesChanged,
      testResult,
      costUsd: codeResult.costUsd,
    },
  });

  // Re-check cancellation after the (potentially slow) code/test phase, before deciding
  // whether to finalize or schedule another tick.
  const afterWork = await prisma.devAgentRun.findUnique({ where: { id: run.id }, select: { status: true } });
  if (afterWork?.status === "canceled") return;

  if (testResult.passed) {
    await prisma.devAgentRun.update({ where: { id: run.id }, data: { status: "succeeded", finishedAt: new Date() } });
    // Worktree intentionally left in place on success (not torn down) so a later stage
    // can push/open a PR from it - teardown here would destroy the work just produced.
    return;
  }

  await reDelay(TICK_DELAY_MS, { kind: "dev_agent_iterate", devAgentRunId: run.id });
}
