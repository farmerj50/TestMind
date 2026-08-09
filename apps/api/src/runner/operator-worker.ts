import { Worker, Job, DelayedError } from 'bullmq';
import path from 'path';
import fsSync from 'fs';
import fs from 'fs/promises';
import { prisma } from '../prisma.js';
import { redis } from './redis.js';
import { enqueueRun, enqueueSelfHeal, enqueueSecurityScan } from './queue.js';
import { CURATED_ROOT, agentSuiteId } from '../testmind/curated-store.js';
import { GENERATED_ROOT } from '../lib/storageRoots.js';
import type { OperatorJobPayload, ResumePhase, SecurityResumeCtx } from './queue.js';
import { createStepRunner } from './step-executor.js';
import { runBrowserCapability } from './capabilities/browser-cap.js';
import { discoverSite, buildLocatorStoreFromScans } from '../testmind/discover.js';
import { generatePlan } from '../testmind/pipeline/generate-plan.js';
import { writeSpecsFromPlan } from '../testmind/pipeline/codegen.js';
import { isLikelyGitRepoUrl } from '../lib/git-url.js';
import { DEFAULT_FRAMEWORK_ID } from '@testmind/core/framework';
import {
  getOctokitForProject,
  pushSpecFilesToBranch,
  ensurePullRequest,
  postPrComment,
  setCommitStatus,
  buildRepairPrBody,
} from './github-writeback.js';
import { validatedEnv } from '../config/env.js';

export { createStepRunner };

// ── Poll intervals (ms) ───────────────────────────────────────────────────────
const RUN_POLL_MS      = 3_000;
const SCAN_POLL_MS     = 5_000;
const REPAIR_POLL_MS   = 5_000;
const APPROVAL_POLL_MS = 4_000;
const AUTONOMOUS_RUN_TIMEOUT_MS = 15 * 60 * 1000;
const AUTONOMOUS_REPAIR_TIMEOUT_MS = 20 * 60 * 1000;

type ReDelayFn = (ms: number, phase: ResumePhase) => Promise<never>;

type OpJobCtx = {
  id: string;
  projectId: string;
  type: string;
  contextJson: unknown;
  requestedBy: string | null;
};

/**
 * Operator worker — orchestrates OperatorJob lifecycle.
 *
 * Uses BullMQ moveToDelayed + ResumePhase checkpoints so the worker thread
 * is released while waiting for external state (test runs, approvals, scans,
 * self-heal completions). On re-entry the job jumps straight to the correct
 * phase rather than starting from scratch.
 */
export const operatorWorker = new Worker(
  'operator-jobs',
  async (job: Job, token?: string) => {
    const payload = job.data as OperatorJobPayload;
    const { operatorJobId, resumePhase } = payload;

    const opJob = await prisma.operatorJob.findUnique({
      where: { id: operatorJobId },
      select: { id: true, projectId: true, type: true, status: true, contextJson: true, requestedBy: true },
    });

    if (!opJob) throw new Error(`OperatorJob ${operatorJobId} not found`);
    if (opJob.status === 'canceled') return;

    /** Release worker thread — re-queues the job with updated checkpoint after `ms`. */
    const reDelay: ReDelayFn = async (ms, phase) => {
      await job.updateData({ operatorJobId, resumePhase: phase } satisfies OperatorJobPayload);
      await job.moveToDelayed(Date.now() + ms, token);
      throw new DelayedError();
    };

    try {
      if (resumePhase) {
        // Resuming from checkpoint — dispatch to the right handler
        await handleResume(opJob, resumePhase, reDelay);
      } else {
        // Fresh start
        await prisma.operatorJob.update({
          where: { id: operatorJobId },
          data: { status: 'running', startedAt: new Date() },
        });

        const ctx = (opJob.contextJson ?? {}) as Record<string, any>;
        if (opJob.type === 'qa' && ctx.autonomous === true) await runAutonomousQaJob(opJob, reDelay);
        else if (opJob.type === 'qa')        await runQaJob(opJob, reDelay);
        else if (opJob.type === 'repair')    await runRepairJob(opJob, reDelay);
        else if (opJob.type === 'discovery') await runDiscoveryJob(opJob);
        else if (opJob.type === 'security')  await runSecurityJob(opJob, reDelay);
        else throw new Error(`OperatorJob type '${opJob.type}' not yet implemented`);
      }

      await finalizeJob(operatorJobId, 'succeeded');
    } catch (err: any) {
      if (err instanceof DelayedError) throw err; // Not a failure — deliberate re-queue
      await finalizeJob(operatorJobId, 'failed', err?.message ?? String(err));
      throw err;
    }
  },
  { connection: redis }
);

// ── Helpers ───────────────────────────────────────────────────────────────────

async function finalizeJob(jobId: string, status: 'succeeded' | 'failed', error?: string) {
  await prisma.operatorJob.update({
    where: { id: jobId },
    data: { status, finishedAt: new Date(), ...(error ? { error } : {}) },
  });
  // Rollup: count tasks by status and write summary into contextJson._rollup
  await writeJobRollup(jobId);

  // Post final GitHub commit status if a SHA was stored on this job
  try {
    const job = await prisma.operatorJob.findUnique({
      where: { id: jobId },
      select: { projectId: true, contextJson: true },
    });
    const sha = (job?.contextJson as any)?.sha as string | undefined;
    const autonomous = (job?.contextJson as any)?.autonomous === true;
    const enableGitHubWriteback = (job?.contextJson as any)?.enableGitHubWriteback === true;
    if (sha && (!autonomous || enableGitHubWriteback)) {
      const gh = await getOctokitForProject(job!.projectId);
      if (gh) {
        const rollup = (job?.contextJson as any)?._rollup as any;
        const passed = rollup?.linkedRunIds?.length ? undefined : undefined;
        await setCommitStatus({
          ...gh, sha,
          state: status === 'succeeded' ? 'success' : 'failure',
          context: 'TestMind / operator',
          description: status === 'succeeded' ? 'Tests passed' : `Tests failed`,
          targetUrl: validatedEnv.TESTMIND_APP_URL || undefined,
        });
      }
    }
  } catch (e) {
    console.warn('[operator-worker] finalizeJob: GitHub status post failed', e);
  }
}

async function writeJobRollup(jobId: string) {
  const tasks = await prisma.operatorTask.findMany({
    where: { jobId },
    select: { status: true, type: true, outputJson: true, testRunId: true },
  });

  const counts = tasks.reduce<Record<string, number>>((acc, t) => {
    acc[t.status] = (acc[t.status] || 0) + 1;
    return acc;
  }, {});

  const linkedRunIds = tasks
    .map((t) => t.testRunId)
    .filter((id): id is string => !!id);

  // Aggregate finding counts from security tasks
  const findingCounts: Record<string, number> = {};
  let repairCount = 0;

  for (const t of tasks) {
    const out = t.outputJson as any;
    if (out?.findingCounts) {
      for (const [sev, n] of Object.entries(out.findingCounts as Record<string, number>)) {
        findingCounts[sev] = (findingCounts[sev] || 0) + n;
      }
    }
    if (t.type === 'repair' && t.status === 'succeeded') repairCount++;
  }

  const rollup = {
    taskCounts: counts,
    linkedRunIds,
    ...(Object.keys(findingCounts).length ? { findingCounts } : {}),
    ...(repairCount ? { repairCount } : {}),
  };

  // Store rollup in contextJson so it's returned by the existing GET /jobs/:id route
  const job = await prisma.operatorJob.findUnique({ where: { id: jobId }, select: { contextJson: true } });
  const existing = (job?.contextJson ?? {}) as Record<string, unknown>;
  await prisma.operatorJob.update({
    where: { id: jobId },
    data: { contextJson: { ...existing, _rollup: rollup } },
  });
}

async function recordArtifact(opts: {
  jobId: string;
  taskId?: string;
  testRunId?: string;
  type: 'screenshot' | 'trace' | 'video' | 'har' | 'report' | 'patch' | 'dom' | 'console' | 'network';
  path: string;
  meta?: Record<string, unknown>;
}) {
  await prisma.operatorArtifact.create({
    data: {
      jobId: opts.jobId,
      taskId: opts.taskId ?? null,
      testRunId: opts.testRunId ?? null,
      type: opts.type,
      path: opts.path,
      metaJson: (opts.meta ?? null) as any,
    },
  });
}

// ── Resume dispatcher ─────────────────────────────────────────────────────────

async function handleResume(opJob: OpJobCtx, phase: ResumePhase, reDelay: ReDelayFn) {
  if (phase.kind === 'autonomous_qa') {
    await runAutonomousQaJob(opJob, reDelay, phase.state);
  } else if (phase.kind === 'wait_run') {
    await checkOrDelayRun(phase.runId, phase.taskId, opJob.id, phase.deadline, reDelay);
  } else if (phase.kind === 'wait_repairs') {
    await checkOrDelayRepairs(opJob.id, phase.remaining, phase.taskMap, phase.deadline, reDelay);
  } else if (phase.kind === 'approval_security') {
    await checkOrDelayApproval(opJob, phase, reDelay);
  } else if (phase.kind === 'wait_scan') {
    await checkOrDelayScan(phase.scanId, phase.taskId, opJob.id, phase.deadline, reDelay);
  }
}

// ── QA job ────────────────────────────────────────────────────────────────────

type AutonomousQaState = {
  stage: 'wait_initial_run' | 'wait_repair' | 'wait_targeted_verify' | 'wait_full_verify';
  generatedDir: string;
  baseUrl?: string;
  adapterId?: string;
  initialRunId: string;
  runId?: string;
  taskId?: string;
  deadline: number;
  remainingTestResultIds?: string[];
  healedCount?: number;
  failedRepairResultIds?: string[];
  currentTestResultId?: string;
  attemptId?: string;
  repairTaskId?: string;
  targetSpec?: string | null;
  testTitle?: string | null;
};

type AutonomousRunResult = {
  status: 'succeeded' | 'failed';
  error: string | null;
  summary: { passed: number; failed: number; skipped: number; total: number };
};

function isPathWithinOrEqual(parent: string, child: string) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

async function collectSpecFiles(root: string, limit = 250): Promise<string[]> {
  const files: string[] = [];
  const stack = [root];
  while (stack.length && files.length < limit) {
    const dir = stack.pop() as string;
    let entries: fsSync.Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && /\.spec\.[cm]?[jt]sx?$/i.test(entry.name)) {
        files.push(full);
        if (files.length >= limit) break;
      }
    }
  }
  return files;
}

async function getRunSummary(runId: string) {
  const results = await prisma.testResult.findMany({
    where: { runId },
    select: { status: true },
  });
  const passed = results.filter((r) => r.status === 'passed').length;
  const failed = results.filter((r) => r.status === 'failed').length;
  const skipped = results.filter((r) => r.status === 'skipped').length;
  return { passed, failed, skipped, total: results.length };
}

async function createHumanInterventionCandidate(opts: {
  opJob: OpJobCtx;
  taskId?: string | null;
  runId?: string | null;
  testResultId?: string | null;
  healingAttemptId?: string | null;
  reason: string;
  context?: Record<string, unknown>;
}) {
  await prisma.humanInterventionCandidate.create({
    data: {
      projectId: opts.opJob.projectId,
      runId: opts.runId ?? null,
      testResultId: opts.testResultId ?? null,
      healingAttemptId: opts.healingAttemptId ?? null,
      operatorJobId: opts.opJob.id,
      operatorTaskId: opts.taskId ?? null,
      reason: opts.reason,
      contextJson: (opts.context ?? {}) as any,
    },
  });
}

async function createInterventionsForClassifications(
  opJob: OpJobCtx,
  runId: string,
  taskId: string | null,
  classifications: Array<{ type: string; testResultId: string; testCaseId: string; title: string; message: string | null }>
) {
  const needsHuman = classifications.filter((c) => c.type !== 'self-heal');
  for (const item of needsHuman) {
    await createHumanInterventionCandidate({
      opJob,
      taskId,
      runId,
      testResultId: item.testResultId,
      reason: item.type === 'blocked' ? 'Blocked by environment or infrastructure' : 'Likely product defect',
      context: item,
    });
  }
}

async function resolveAutonomousContext(opJob: OpJobCtx) {
  const ctx = (opJob.contextJson ?? {}) as Record<string, any>;
  const project = await prisma.project.findUnique({
    where: { id: opJob.projectId },
    select: { repoUrl: true, ownerId: true },
  });
  if (!project) throw new Error(`Project ${opJob.projectId} not found`);

  const repoUrl = project.repoUrl?.trim() ?? '';
  const baseUrl =
    (typeof ctx.baseUrl === 'string' && ctx.baseUrl.trim() ? ctx.baseUrl.trim() : '') ||
    (!isLikelyGitRepoUrl(repoUrl) && /^https?:\/\//i.test(repoUrl) ? repoUrl : '');
  if (!baseUrl) {
    throw new Error('Autonomous QA requires a baseUrl or a project repoUrl that points to an app URL');
  }

  const adapterId = typeof ctx.adapterId === 'string' && ctx.adapterId ? ctx.adapterId : DEFAULT_FRAMEWORK_ID;
  return { ctx, project, baseUrl, adapterId };
}

async function validateAutonomousGeneratedDir(opJob: OpJobCtx, generatedDir: string) {
  const project = await prisma.project.findUnique({
    where: { id: opJob.projectId },
    select: { ownerId: true },
  });
  if (!project) throw new Error(`Project ${opJob.projectId} not found`);

  const task = await prisma.operatorTask.create({
    data: {
      jobId: opJob.id,
      type: 'verify',
      status: 'running',
      startedAt: new Date(),
      inputJson: { phase: 'generated-path-validation', generatedDir },
    },
  });

  try {
    const expectedRoot = path.resolve(GENERATED_ROOT, `playwright-ts-${project.ownerId}`, opJob.projectId);
    const resolvedGeneratedDir = path.resolve(generatedDir);
    if (!isPathWithinOrEqual(expectedRoot, resolvedGeneratedDir)) {
      throw new Error(`Generated specs must stay under ${expectedRoot}`);
    }

    const specs = await collectSpecFiles(resolvedGeneratedDir);
    if (specs.length === 0) {
      throw new Error(`No generated spec files found in ${resolvedGeneratedDir}`);
    }

    const repoRoot = process.cwd();
    const roots = [repoRoot, path.join(repoRoot, 'apps', 'api'), path.join(repoRoot, 'apps', 'web')]
      .filter((root) => fsSync.existsSync(root))
      .map((root) => ({
        root,
        relativeGeneratedDir: path.relative(root, resolvedGeneratedDir).replace(/\\/g, '/'),
      }));

    await prisma.operatorTask.update({
      where: { id: task.id },
      data: {
        status: 'succeeded',
        finishedAt: new Date(),
        outputJson: {
          phase: 'generated-path-validation',
          generatedDir: resolvedGeneratedDir,
          expectedRoot,
          specCount: specs.length,
          roots,
        },
      },
    });
  } catch (err: any) {
    const message = err?.message ?? String(err);
    await prisma.operatorTask.update({
      where: { id: task.id },
      data: { status: 'failed', finishedAt: new Date(), error: message },
    });
    await createHumanInterventionCandidate({
      opJob,
      taskId: task.id,
      reason: 'Generated test path validation failed',
      context: { generatedDir, error: message },
    });
    throw err;
  }
}

async function validateAutonomousRepairedSpec(targetSpec: string | null | undefined, generatedDir: string) {
  if (!targetSpec) throw new Error('Self-heal did not report a target spec');
  const resolved = path.resolve(targetSpec);
  const allowedRoots = [path.resolve(generatedDir), path.resolve(GENERATED_ROOT), path.resolve(CURATED_ROOT)];
  if (!allowedRoots.some((root) => isPathWithinOrEqual(root, resolved))) {
    throw new Error(`Repaired spec escaped allowed roots: ${resolved}`);
  }
  if (!fsSync.existsSync(resolved)) {
    throw new Error(`Repaired spec does not exist: ${resolved}`);
  }
  return resolved;
}

async function createAutonomousRun(
  opJob: OpJobCtx,
  opts: {
    taskType: 'execute' | 'verify';
    inputJson: Record<string, unknown>;
    generatedDir: string;
    baseUrl?: string;
    adapterId?: string;
    file: string;
    grep?: string | null;
    rerunOfId?: string;
  }
) {
  const ctx = (opJob.contextJson ?? {}) as Record<string, any>;
  const task = await prisma.operatorTask.create({
    data: {
      jobId: opJob.id,
      type: opts.taskType,
      status: 'running',
      startedAt: new Date(),
      inputJson: opts.inputJson as any,
    },
  });

  const run = await prisma.testRun.create({
    data: {
      projectId: opJob.projectId,
      status: 'queued',
      trigger: 'operator',
      rerunOfId: opts.rerunOfId,
      environmentId: typeof ctx.environmentId === 'string' ? ctx.environmentId : undefined,
      paramsJson: {
        ...ctx,
        autonomous: true,
        mode: 'ai',
        baseUrl: opts.baseUrl,
        file: opts.file,
        targetSpec: opts.file,
        generatedDir: opts.generatedDir,
        disableAutoSelfHeal: true,
        enableGitHubWriteback: ctx.enableGitHubWriteback === true,
      },
    },
  });

  await prisma.operatorTask.update({ where: { id: task.id }, data: { testRunId: run.id } });
  await enqueueRun(run.id, {
    projectId: opJob.projectId,
    adapterId: opts.adapterId,
    baseUrl: opts.baseUrl,
    mode: 'ai',
    file: opts.file,
    grep: opts.grep ?? undefined,
    timeoutMs: 12 * 60 * 1000,
    livePreview: true,
  });

  return { task, run };
}

async function waitAutonomousRun(
  opJob: OpJobCtx,
  state: AutonomousQaState,
  reDelay: ReDelayFn
): Promise<AutonomousRunResult> {
  const runId = state.runId;
  const taskId = state.taskId;
  if (!runId || !taskId) throw new Error(`Autonomous stage ${state.stage} missing run/task id`);

  const run = await prisma.testRun.findUnique({
    where: { id: runId },
    select: { status: true, error: true },
  });
  if (!run) throw new Error(`TestRun ${runId} not found`);

  if (run.status === 'succeeded' || run.status === 'failed') {
    const summary = await getRunSummary(runId);
    await prisma.operatorTask.update({
      where: { id: taskId },
      data: {
        status: run.status === 'succeeded' ? 'succeeded' : 'failed',
        finishedAt: new Date(),
        error: run.error ?? null,
        outputJson: { phase: state.stage, testRunId: runId, finalStatus: run.status, summary },
      },
    });
    await recordArtifact({
      jobId: opJob.id,
      taskId,
      testRunId: runId,
      type: 'report',
      path: `runs/${runId}/playwright-report.json`,
      meta: { phase: state.stage, finalStatus: run.status },
    });
    return { status: run.status, error: run.error ?? null, summary };
  }

  if (Date.now() > state.deadline) {
    await prisma.operatorTask.update({
      where: { id: taskId },
      data: { status: 'failed', finishedAt: new Date(), error: `Timed out waiting for TestRun ${runId}` },
    });
    await prisma.testRun.updateMany({
      where: { id: runId, status: { in: ['queued', 'running'] } },
      data: { status: 'failed', finishedAt: new Date(), error: 'Cancelled: autonomous QA deadline exceeded' },
    });
    throw new Error(`Autonomous QA timed out waiting for run ${runId}`);
  }

  await reDelay(RUN_POLL_MS, { kind: 'autonomous_qa', state });
}

async function recordAutonomousFullSuitePass(opJob: OpJobCtx, state: AutonomousQaState, result: AutonomousRunResult) {
  await prisma.operatorTask.create({
    data: {
      jobId: opJob.id,
      type: 'verify',
      status: 'succeeded',
      startedAt: new Date(),
      finishedAt: new Date(),
      testRunId: state.runId ?? state.initialRunId,
      inputJson: { phase: 'full-suite-verification', generatedDir: state.generatedDir },
      outputJson: {
        phase: 'full-suite-verification',
        runId: state.runId ?? state.initialRunId,
        generatedDir: state.generatedDir,
        summary: result.summary,
      },
    },
  });
}

async function continueAutonomousAfterFailedRun(
  opJob: OpJobCtx,
  reDelay: ReDelayFn,
  state: AutonomousQaState,
  runId: string
) {
  const classifications = await classifyRunFailures(runId);
  const triageTask = await prisma.operatorTask.create({
    data: {
      jobId: opJob.id,
      type: 'triage',
      status: 'succeeded',
      startedAt: new Date(),
      finishedAt: new Date(),
      outputJson: { runId, classifications, phase: 'autonomous-triage' },
    },
  });

  await createInterventionsForClassifications(opJob, runId, triageTask.id, classifications);

  const selfHealableIds = classifications
    .filter((c) => c.type === 'self-heal')
    .map((c) => c.testResultId);

  if (selfHealableIds.length === 0) {
    throw new Error('Autonomous QA found failures that require human intervention');
  }

  await startNextAutonomousRepair(opJob, reDelay, {
    ...state,
    remainingTestResultIds: selfHealableIds,
    healedCount: state.healedCount ?? 0,
    failedRepairResultIds: state.failedRepairResultIds ?? [],
  });
}

async function startNextAutonomousRepair(
  opJob: OpJobCtx,
  reDelay: ReDelayFn,
  state: AutonomousQaState
): Promise<void> {
  const remaining = [...(state.remainingTestResultIds ?? [])];
  while (remaining.length > 0) {
    const testResultId = remaining.shift() as string;
    const result = await prisma.testResult.findFirst({
      where: {
        id: testResultId,
        runId: state.initialRunId,
        status: 'failed',
        testCase: { status: { not: 'archived' } },
      },
      include: { testCase: { select: { id: true, title: true } } },
    });
    if (!result?.testCase) continue;

    const repairTask = await prisma.operatorTask.create({
      data: {
        jobId: opJob.id,
        type: 'repair',
        status: 'running',
        startedAt: new Date(),
        inputJson: {
          phase: 'sequential-autonomous-repair',
          testResultId,
          testTitle: result.testCase.title,
        },
      },
    });

    const attemptsSoFar = await prisma.testHealingAttempt.count({ where: { testResultId } });
    const attempt = await prisma.testHealingAttempt.create({
      data: {
        run: { connect: { id: state.initialRunId } },
        testResult: { connect: { id: testResultId } },
        testCase: { connect: { id: result.testCase.id } },
        attempt: attemptsSoFar + 1,
        status: 'queued',
      },
      select: { id: true },
    });

    await enqueueSelfHeal({
      runId: state.initialRunId,
      testResultId,
      testCaseId: result.testCase.id,
      attemptId: attempt.id,
      projectId: opJob.projectId,
      adapterId: state.adapterId,
      totalFailed: (state.remainingTestResultIds ?? []).length,
      testTitle: result.testCase.title,
      baseUrl: state.baseUrl,
      skipAutoRerun: true,
    });

    await reDelay(REPAIR_POLL_MS, {
      kind: 'autonomous_qa',
      state: {
        ...state,
        stage: 'wait_repair',
        remainingTestResultIds: remaining,
        currentTestResultId: testResultId,
        repairTaskId: repairTask.id,
        attemptId: attempt.id,
        testTitle: result.testCase.title,
        deadline: Date.now() + AUTONOMOUS_REPAIR_TIMEOUT_MS,
      } satisfies AutonomousQaState,
    });
  }

  await startAutonomousFullSuiteVerification(opJob, reDelay, state);
}

async function waitAutonomousRepair(opJob: OpJobCtx, reDelay: ReDelayFn, state: AutonomousQaState) {
  if (!state.attemptId || !state.repairTaskId || !state.currentTestResultId) {
    throw new Error('Autonomous repair state is incomplete');
  }

  const attempt = await prisma.testHealingAttempt.findUnique({
    where: { id: state.attemptId },
    select: {
      id: true,
      status: true,
      error: true,
      targetSpec: true,
      testResultId: true,
      testCase: { select: { title: true } },
    },
  });
  if (!attempt) throw new Error(`Healing attempt ${state.attemptId} not found`);

  if (attempt.status === 'queued' || attempt.status === 'running') {
    if (Date.now() > state.deadline) {
      await prisma.operatorTask.update({
        where: { id: state.repairTaskId },
        data: { status: 'failed', finishedAt: new Date(), error: 'Self-heal did not complete in time' },
      });
      await createHumanInterventionCandidate({
        opJob,
        taskId: state.repairTaskId,
        runId: state.initialRunId,
        testResultId: state.currentTestResultId,
        healingAttemptId: state.attemptId,
        reason: 'Autonomous self-heal timed out',
      });
      await startNextAutonomousRepair(opJob, reDelay, {
        ...state,
        failedRepairResultIds: [...(state.failedRepairResultIds ?? []), state.currentTestResultId],
      });
      return;
    }
    await reDelay(REPAIR_POLL_MS, { kind: 'autonomous_qa', state });
  }

  if (attempt.status !== 'succeeded') {
    await prisma.operatorTask.update({
      where: { id: state.repairTaskId },
      data: {
        status: attempt.status === 'skipped' ? 'skipped' : 'failed',
        finishedAt: new Date(),
        error: attempt.error ?? `Self-heal ended with status ${attempt.status}`,
        outputJson: { healingAttemptId: attempt.id, finalStatus: attempt.status },
      },
    });
    await createHumanInterventionCandidate({
      opJob,
      taskId: state.repairTaskId,
      runId: state.initialRunId,
      testResultId: state.currentTestResultId,
      healingAttemptId: attempt.id,
      reason: 'Autonomous self-heal could not repair the failure',
      context: { finalStatus: attempt.status, error: attempt.error ?? null },
    });
    await startNextAutonomousRepair(opJob, reDelay, {
      ...state,
      failedRepairResultIds: [...(state.failedRepairResultIds ?? []), state.currentTestResultId],
    });
    return;
  }

  let repairedSpec: string;
  try {
    repairedSpec = await validateAutonomousRepairedSpec(attempt.targetSpec, state.generatedDir);
  } catch (err: any) {
    const message = err?.message ?? String(err);
    await prisma.operatorTask.update({
      where: { id: state.repairTaskId },
      data: { status: 'failed', finishedAt: new Date(), error: message },
    });
    await createHumanInterventionCandidate({
      opJob,
      taskId: state.repairTaskId,
      runId: state.initialRunId,
      testResultId: state.currentTestResultId,
      healingAttemptId: attempt.id,
      reason: 'Repaired spec path validation failed',
      context: { targetSpec: attempt.targetSpec, error: message },
    });
    await startNextAutonomousRepair(opJob, reDelay, {
      ...state,
      failedRepairResultIds: [...(state.failedRepairResultIds ?? []), state.currentTestResultId],
    });
    return;
  }

  await prisma.operatorTask.update({
    where: { id: state.repairTaskId },
    data: {
      status: 'succeeded',
      finishedAt: new Date(),
      outputJson: {
        healingAttemptId: attempt.id,
        targetSpec: repairedSpec,
        finalStatus: attempt.status,
      },
    },
  });
  await recordArtifact({
    jobId: opJob.id,
    taskId: state.repairTaskId,
    testRunId: state.initialRunId,
    type: 'patch',
    path: `runs/${state.initialRunId}/self-heal-patch-${attempt.id}.diff`,
    meta: { healingAttemptId: attempt.id, outcome: 'healed', targetSpec: repairedSpec },
  });

  const verify = await createAutonomousRun(opJob, {
    taskType: 'verify',
    inputJson: {
      phase: 'targeted-verification',
      healingAttemptId: attempt.id,
      testResultId: state.currentTestResultId,
      targetSpec: repairedSpec,
    },
    generatedDir: state.generatedDir,
    baseUrl: state.baseUrl,
    adapterId: state.adapterId,
    file: repairedSpec,
    grep: attempt.testCase?.title ?? state.testTitle ?? undefined,
    rerunOfId: state.initialRunId,
  });

  await reDelay(RUN_POLL_MS, {
    kind: 'autonomous_qa',
    state: {
      ...state,
      stage: 'wait_targeted_verify',
      runId: verify.run.id,
      taskId: verify.task.id,
      targetSpec: repairedSpec,
      testTitle: attempt.testCase?.title ?? state.testTitle ?? null,
      deadline: Date.now() + AUTONOMOUS_RUN_TIMEOUT_MS,
    } satisfies AutonomousQaState,
  });
}

async function waitAutonomousTargetedVerify(opJob: OpJobCtx, reDelay: ReDelayFn, state: AutonomousQaState) {
  const result = await waitAutonomousRun(opJob, state, reDelay);
  if (state.attemptId) {
    await prisma.testHealingAttempt.update({
      where: { id: state.attemptId },
      data: { executionAfter: result.summary as any },
    });
  }

  if (result.status === 'succeeded') {
    await startNextAutonomousRepair(opJob, reDelay, {
      ...state,
      healedCount: (state.healedCount ?? 0) + 1,
    });
    return;
  }

  await createHumanInterventionCandidate({
    opJob,
    taskId: state.taskId,
    runId: state.runId,
    testResultId: state.currentTestResultId,
    healingAttemptId: state.attemptId,
    reason: 'Targeted verification failed after autonomous repair',
    context: { targetSpec: state.targetSpec, summary: result.summary, error: result.error },
  });
  await startNextAutonomousRepair(opJob, reDelay, {
    ...state,
    failedRepairResultIds: [...(state.failedRepairResultIds ?? []), state.currentTestResultId ?? 'unknown'],
  });
}

async function startAutonomousFullSuiteVerification(opJob: OpJobCtx, reDelay: ReDelayFn, state: AutonomousQaState) {
  const verify = await createAutonomousRun(opJob, {
    taskType: 'verify',
    inputJson: {
      phase: 'full-suite-verification',
      generatedDir: state.generatedDir,
      healedCount: state.healedCount ?? 0,
      failedRepairResultIds: state.failedRepairResultIds ?? [],
    },
    generatedDir: state.generatedDir,
    baseUrl: state.baseUrl,
    adapterId: state.adapterId,
    file: state.generatedDir,
    rerunOfId: state.initialRunId,
  });

  await reDelay(RUN_POLL_MS, {
    kind: 'autonomous_qa',
    state: {
      ...state,
      stage: 'wait_full_verify',
      runId: verify.run.id,
      taskId: verify.task.id,
      deadline: Date.now() + AUTONOMOUS_RUN_TIMEOUT_MS,
    } satisfies AutonomousQaState,
  });
}

async function waitAutonomousFullSuiteVerify(opJob: OpJobCtx, reDelay: ReDelayFn, state: AutonomousQaState) {
  const result = await waitAutonomousRun(opJob, state, reDelay);
  if (result.status === 'succeeded') return;

  const runId = state.runId ?? state.initialRunId;
  const classifications = await classifyRunFailures(runId);
  await createInterventionsForClassifications(opJob, runId, state.taskId ?? null, classifications);
  throw new Error('Autonomous QA full-suite verification failed');
}

async function runAutonomousQaJob(opJob: OpJobCtx, reDelay: ReDelayFn, rawState?: Record<string, any>) {
  if (!validatedEnv.TM_AUTONOMOUS_QA_ENABLED) {
    throw new Error('Autonomous QA is not enabled');
  }

  const state = rawState as AutonomousQaState | undefined;
  if (state?.stage === 'wait_initial_run') {
    const result = await waitAutonomousRun(opJob, state, reDelay);
    if (result.status === 'succeeded') {
      await recordAutonomousFullSuitePass(opJob, state, result);
      return;
    }
    await continueAutonomousAfterFailedRun(opJob, reDelay, state, state.initialRunId);
    return;
  }
  if (state?.stage === 'wait_repair') {
    await waitAutonomousRepair(opJob, reDelay, state);
    return;
  }
  if (state?.stage === 'wait_targeted_verify') {
    await waitAutonomousTargetedVerify(opJob, reDelay, state);
    return;
  }
  if (state?.stage === 'wait_full_verify') {
    await waitAutonomousFullSuiteVerify(opJob, reDelay, state);
    return;
  }

  const { baseUrl, adapterId } = await resolveAutonomousContext(opJob);
  const rawCtx = (opJob.contextJson ?? {}) as Record<string, any>;
  const discovery = await runDiscoveryJob({
    ...opJob,
    contextJson: {
      ...rawCtx,
      baseUrl,
      maxPages: Number(rawCtx.maxPages ?? 50),
    },
  });
  const generatedDir = typeof discovery?.outDir === 'string' ? discovery.outDir : '';
  await validateAutonomousGeneratedDir(opJob, generatedDir);

  const initial = await createAutonomousRun(opJob, {
    taskType: 'execute',
    inputJson: { phase: 'initial-generated-suite', generatedDir, baseUrl },
    generatedDir,
    baseUrl,
    adapterId,
    file: generatedDir,
  });

  await reDelay(RUN_POLL_MS, {
    kind: 'autonomous_qa',
    state: {
      stage: 'wait_initial_run',
      generatedDir,
      baseUrl,
      adapterId,
      initialRunId: initial.run.id,
      runId: initial.run.id,
      taskId: initial.task.id,
      deadline: Date.now() + AUTONOMOUS_RUN_TIMEOUT_MS,
      remainingTestResultIds: [],
      healedCount: 0,
      failedRepairResultIds: [],
    } satisfies AutonomousQaState,
  });
}

async function runQaJob(opJob: OpJobCtx, reDelay: ReDelayFn) {
  const ctx = (opJob.contextJson ?? {}) as Record<string, any>;

  // Post "pending" status to GitHub if a commit SHA is present
  const sha = ctx.sha as string | undefined;
  if (sha) {
    try {
      const gh = await getOctokitForProject(opJob.projectId);
      if (gh) {
        await setCommitStatus({
          ...gh, sha,
          state: 'pending',
          context: 'TestMind / operator',
          description: 'Tests running…',
          targetUrl: validatedEnv.TESTMIND_APP_URL || undefined,
        });
      }
    } catch (e) {
      console.warn('[operator-worker] runQaJob: pending status post failed', e);
    }
  }

  const project = await prisma.project.findUnique({
    where: { id: opJob.projectId },
    select: { repoUrl: true, ownerId: true },
  });
  const explicitMode = ctx.mode as string | undefined;
  const inferredMode = explicitMode ?? (isLikelyGitRepoUrl(project?.repoUrl) ? 'regular' : 'ai');
  const repoUrl = project?.repoUrl?.trim() ?? '';

  let envBaseUrl: string | undefined;
  if (ctx.environmentId) {
    const env = await prisma.environment.findUnique({
      where: { id: ctx.environmentId as string },
      select: { baseUrl: true },
    });
    envBaseUrl = env?.baseUrl || undefined;
  }

  const inferredBaseUrl: string | undefined =
    envBaseUrl ||
    ctx.baseUrl ||
    (!isLikelyGitRepoUrl(repoUrl) && /^https?:\/\//i.test(repoUrl) ? repoUrl : undefined);

  const task = await prisma.operatorTask.create({
    data: {
      jobId: opJob.id,
      type: 'execute',
      status: 'running',
      startedAt: new Date(),
      inputJson: ctx,
    },
  });

  const run = await prisma.testRun.create({
    data: {
      projectId: opJob.projectId,
      status: 'queued',
      trigger: 'operator',
      paramsJson: { ...ctx, mode: inferredMode, baseUrl: inferredBaseUrl },
    },
  });

  await prisma.operatorTask.update({ where: { id: task.id }, data: { testRunId: run.id } });

  // Resolve the file scope for this run:
  // 1. Explicit file from context (caller-specified)
  // 2. Agent suite dir for this project (if it exists on disk)
  // 3. CuratedSuite dir from contextJson.suiteId (the suite the job was started from)
  // 4. First available curated suite for this project (avoid running all specs unscoped)
  let resolvedFile: string | undefined = ctx.file;
  if (!resolvedFile) {
    const agentDir = path.join(CURATED_ROOT, agentSuiteId(opJob.projectId));
    if (fsSync.existsSync(agentDir)) {
      resolvedFile = agentDir;
    } else if (ctx.suiteId) {
      const curatedSuite = await prisma.curatedSuite.findUnique({
        where: { id: ctx.suiteId },
        select: { rootRel: true },
      });
      if (curatedSuite) {
        const suiteDir = path.join(CURATED_ROOT, curatedSuite.rootRel);
        if (fsSync.existsSync(suiteDir)) resolvedFile = suiteDir;
      }
    }
    if (!resolvedFile) {
      const suites = await prisma.curatedSuite.findMany({
        where: { projectId: opJob.projectId },
        select: { rootRel: true },
        orderBy: { createdAt: 'asc' },
      });
      for (const suite of suites) {
        const suiteDir = path.join(CURATED_ROOT, suite.rootRel);
        if (fsSync.existsSync(suiteDir)) { resolvedFile = suiteDir; break; }
      }
    }

    // Final fallback: scan generated root for {adapterId}-{ownerId}/{projectId} directory.
    // Handles cases where curated suite dirs don't exist on disk (e.g. dev without volume).
    if (!resolvedFile && project?.ownerId) {
      try {
        if (fsSync.existsSync(GENERATED_ROOT)) {
          const adapters = fsSync.readdirSync(GENERATED_ROOT, { withFileTypes: true })
            .filter((d) => d.isDirectory());
          for (const adapter of adapters) {
            const candidate = path.join(GENERATED_ROOT, adapter.name, opJob.projectId);
            if (fsSync.existsSync(candidate)) {
              resolvedFile = candidate;
              console.log(`[operator-worker] qa: using generated dir as fallback: ${candidate}`);
              break;
            }
          }
        }
      } catch {
        // ignore scan errors
      }
    }

    if (!resolvedFile) {
      throw new Error(
        `No spec directory found for project ${opJob.projectId}. ` +
        `Sync specs to the curated suite or generate specs first.`
      );
    }
  }

  await enqueueRun(run.id, {
    projectId: opJob.projectId,
    baseUrl: inferredBaseUrl,
    mode: inferredMode as 'regular' | 'ai',
    file: resolvedFile,
    grep: ctx.grep,
    timeoutMs: 12 * 60 * 1000, // QA agent runs need more time than the 30s worker default
  });

  const deadline = Date.now() + 15 * 60 * 1000;
  await checkOrDelayRun(run.id, task.id, opJob.id, deadline, reDelay);

  // ── Journey 2: classify failures and branch into repair or defect ──────────
  const finishedRun = await prisma.testRun.findUnique({
    where: { id: run.id },
    select: { status: true },
  });

  if (finishedRun?.status !== 'failed') return; // all passed — done

  const classifications = await classifyRunFailures(run.id);

  // Persist triage output so the UI and rollup can surface it
  await prisma.operatorTask.create({
    data: {
      jobId: opJob.id,
      type: 'triage',
      status: 'succeeded',
      startedAt: new Date(),
      finishedAt: new Date(),
      outputJson: {
        runId: run.id,
        classifications,
      },
    },
  });

  const selfHealable = classifications.filter((c) => c.type === 'self-heal');
  const defects      = classifications.filter((c) => c.type === 'defect');
  const blocked      = classifications.filter((c) => c.type === 'blocked');

  // Route self-healable failures into Journey 1 via the existing repair job
  if (selfHealable.length > 0) {
    console.log(
      `[operator-worker] qa: routing ${selfHealable.length} self-healable failure(s) to repair for run ${run.id}`
    );
    const { healedCount } = await runRepairJob(
      {
        ...opJob,
        contextJson: {
          ...(ctx as object),
          runId: run.id,
          baseUrl: inferredBaseUrl,
          source: 'qa-agent',
        },
      },
      reDelay
    );

    if (healedCount > 0) {
      console.log(`[operator-worker] qa: ${healedCount} test(s) healed — re-running full suite`);

      // Clear the original execute task's testRunId so Jenkins sees "running" during re-run
      await prisma.operatorTask.update({
        where: { id: task.id },
        data: { testRunId: null },
      });

      // Create a retest task so the UI surfaces the verification step
      const retestTask = await prisma.operatorTask.create({
        data: {
          jobId: opJob.id,
          type: 'retest',
          status: 'running',
          startedAt: new Date(),
          inputJson: { healedCount, label: `Re-running suite after ${healedCount} repair(s)` },
        },
      });

      // New full test run with the same scope and environment
      const retestRun = await prisma.testRun.create({
        data: {
          projectId: opJob.projectId,
          status: 'queued',
          trigger: 'operator',
          environmentId: (ctx.environmentId as string | undefined) ?? undefined,
          paramsJson: { ...ctx, mode: inferredMode, baseUrl: inferredBaseUrl },
        },
      });

      // Link task → run immediately so the status endpoint finds it
      await prisma.operatorTask.update({
        where: { id: retestTask.id },
        data: { testRunId: retestRun.id },
      });

      await enqueueRun(retestRun.id, {
        projectId: opJob.projectId,
        baseUrl: inferredBaseUrl,
        mode: inferredMode as 'regular' | 'ai',
        file: resolvedFile,
        grep: ctx.grep as string | undefined,
        timeoutMs: 12 * 60 * 1000,
      });

      const retestDeadline = Date.now() + 15 * 60 * 1000;
      await checkOrDelayRun(retestRun.id, retestTask.id, opJob.id, retestDeadline, reDelay);

      const retestResult = await prisma.testRun.findUnique({
        where: { id: retestRun.id },
        select: { status: true },
      });
      console.log(`[operator-worker] qa: retest completed with status=${retestResult?.status}`);

      // GitHub writeback after successful retest
      if (retestResult?.status === 'succeeded') {
        try {
          const gh = await getOctokitForProject(opJob.projectId);
          if (gh) {
            const attempts = await prisma.testHealingAttempt.findMany({
              where: { runId: run.id, status: 'succeeded' },
              select: {
                id: true, targetSpec: true, repairedSpec: true, originalSpec: true,
                modelUsed: true, repairReason: true, confidenceScore: true,
                executionBefore: true, diff: true,
              },
            });

            if (attempts.length > 0) {
              // Collect retest summary
              const retestResults = await prisma.testResult.findMany({
                where: { runId: retestRun.id },
                select: { status: true },
              });
              const retestSummary = {
                passed: retestResults.filter((r) => r.status === 'passed').length,
                failed: retestResults.filter((r) => r.status === 'failed').length,
                total: retestResults.length,
              };

              // Persist executionAfter
              await prisma.testHealingAttempt.updateMany({
                where: { id: { in: attempts.map((a) => a.id) } },
                data: { executionAfter: retestSummary as any },
              });

              const files = await Promise.all(
                attempts
                  .filter((a) => a.targetSpec)
                  .map(async (a) => ({
                    path: a.targetSpec!,
                    content: a.repairedSpec ?? await fs.readFile(a.targetSpec!, 'utf8').catch(() => ''),
                  }))
              ).then((arr) => arr.filter((f) => f.content));

              if (files.length > 0) {
                const branchName = `testmind/heal-${opJob.id.slice(0, 8)}`;
                const minConf = Math.min(...attempts.map((a) => a.confidenceScore ?? 0));
                const prTitle = `TestMind: repaired ${attempts.length} test(s)`;
                const prBody = buildRepairPrBody({ attempts, retestSummary });

                const { commitSha } = await pushSpecFilesToBranch({
                  ...gh, branch: branchName, baseBranch: gh.defaultBranch, files,
                  commitMessage: `fix(tests): self-heal repair — ${attempts.length} spec(s) [job ${opJob.id.slice(0, 8)}]`,
                });

                if (minConf >= 95) {
                  const { prNumber, prUrl } = await ensurePullRequest({
                    ...gh, branch: branchName, baseBranch: gh.defaultBranch,
                    title: prTitle, body: prBody, draft: false,
                  });
                  await postPrComment({ ...gh, prNumber,
                    body: `✅ Retest passed after repair (commit \`${commitSha.slice(0, 7)}\`). [View PR](${prUrl})`,
                  });
                } else if (minConf >= 80) {
                  const { prNumber, prUrl } = await ensurePullRequest({
                    ...gh, branch: branchName, baseBranch: gh.defaultBranch,
                    draft: true,
                    title: `[DRAFT] ${prTitle}`,
                    body: `⚠️ Confidence: ${minConf}% — QA review recommended.\n\n${prBody}`,
                  });
                  await postPrComment({ ...gh, prNumber,
                    body: `⚠️ Draft PR opened (confidence ${minConf}%). Manual review required before merge.`,
                  });
                } else {
                  await prisma.testHealingAttempt.updateMany({
                    where: { id: { in: attempts.map((a) => a.id) } },
                    data: { status: 'needs_review' },
                  });
                  console.warn(`[operator-worker] repair confidence too low (${minConf}%) — no PR for job ${opJob.id}`);
                }
              }
            }
          }
        } catch (e) {
          console.warn('[operator-worker] qa: GitHub writeback failed (non-fatal)', e);
        }
      }
    }
  }

  // Log defects and blocked items as operator tasks with evidence
  if (defects.length > 0) {
    await prisma.operatorTask.create({
      data: {
        jobId: opJob.id,
        type: 'triage',
        status: 'failed',
        startedAt: new Date(),
        finishedAt: new Date(),
        outputJson: {
          phase: 'defects',
          runId: run.id,
          defects: defects.map((d) => ({
            testResultId: d.testResultId,
            testCaseId: d.testCaseId,
            title: d.title,
            severity: 'medium',
            actual: d.message,
            routeTo: 'dev',
          })),
        },
      },
    });
    console.log(
      `[operator-worker] qa: ${defects.length} product defect(s) recorded for run ${run.id} — route to dev`
    );
  }

  if (blocked.length > 0) {
    console.log(
      `[operator-worker] qa: ${blocked.length} blocked failure(s) (infra/env) for run ${run.id}`
    );
  }
}

/**
 * Journey 2: Classify failed TestResults so the QA agent can route each
 * failure to the correct downstream path:
 *   "self-heal"  → automation drift, selector issues — Journey 1 applies
 *   "blocked"    → infra/env/network — needs env owner
 *   "defect"     → likely product regression — route to dev
 */
async function classifyRunFailures(runId: string) {
  const failedResults = await prisma.testResult.findMany({
    where: { runId, status: 'failed' },
    include: { testCase: { select: { id: true, title: true } } },
  });

  return failedResults.map((r) => {
    const msg = (r.message ?? '').toLowerCase();

    const likelyAutomation =
      msg.includes('locator') ||
      msg.includes('tobevisible') ||
      msg.includes('element(s) not found') ||
      msg.includes('waiting for') ||
      msg.includes('selector') ||
      msg.includes('strict mode violation');

    const likelyInfra =
      msg.includes('timeout') ||
      msg.includes('net::') ||
      msg.includes('econnrefused') ||
      msg.includes('navigation') ||
      msg.includes('err_connection');

    const type = likelyAutomation ? 'self-heal' : likelyInfra ? 'blocked' : 'defect';

    return {
      testResultId: r.id,
      testCaseId: r.testCaseId,
      title: r.testCase?.title ?? r.testCaseId,
      type,
      message: r.message ?? null,
    };
  });
}

async function checkOrDelayRun(
  runId: string,
  taskId: string,
  jobId: string,
  deadline: number,
  reDelay: ReDelayFn
) {
  const run = await prisma.testRun.findUnique({
    where: { id: runId },
    select: { status: true, error: true },
  });

  if (!run) throw new Error(`TestRun ${runId} not found`);

  if (run.status === 'succeeded' || run.status === 'failed') {
    await prisma.operatorTask.update({
      where: { id: taskId },
      data: {
        status: run.status === 'succeeded' ? 'succeeded' : 'failed',
        finishedAt: new Date(),
        error: run.error ?? null,
        outputJson: { testRunId: runId, finalStatus: run.status },
      },
    });
    // Record run report as an artifact
    await recordArtifact({
      jobId,
      taskId,
      testRunId: runId,
      type: 'report',
      path: `runs/${runId}/playwright-report.json`,
      meta: { finalStatus: run.status },
    });
    return;
  }

  if (Date.now() > deadline) {
    await prisma.operatorTask.update({
      where: { id: taskId },
      data: { status: 'failed', finishedAt: new Date(), error: `Timed out waiting for TestRun ${runId}` },
    });
    // Cancel the underlying run so it doesn't stay stuck in "running" forever
    await prisma.testRun.updateMany({
      where: { id: runId, status: { in: ['queued', 'running'] } },
      data: { status: 'failed', finishedAt: new Date(), error: 'Cancelled: operator job deadline exceeded' },
    });
    throw new Error(`waitForRun timeout for run ${runId}`);
  }

  await reDelay(RUN_POLL_MS, { kind: 'wait_run', runId, taskId, deadline });
}

// ── Repair job ────────────────────────────────────────────────────────────────

async function runRepairJob(opJob: OpJobCtx, reDelay: ReDelayFn): Promise<{ healedCount: number }> {
  const ctx = (opJob.contextJson ?? {}) as Record<string, any>;
  const maxTests = Number(ctx.maxTests ?? 10);

  const project = await prisma.project.findUnique({
    where: { id: opJob.projectId },
    select: { repoUrl: true },
  });
  const repoUrl = project?.repoUrl?.trim() ?? '';
  const baseUrl: string | undefined =
    ctx.baseUrl ||
    (!isLikelyGitRepoUrl(repoUrl) && /^https?:\/\//i.test(repoUrl) ? repoUrl : undefined);

  let targetRunId = ctx.runId as string | undefined;
  if (!targetRunId) {
    const recent = await prisma.testRun.findFirst({
      where: { projectId: opJob.projectId, status: 'failed' },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    if (!recent) throw new Error('No failed test run found for this project to repair');
    targetRunId = recent.id;
  }

  const triageTask = await prisma.operatorTask.create({
    data: {
      jobId: opJob.id,
      type: 'triage',
      status: 'running',
      startedAt: new Date(),
      inputJson: { runId: targetRunId, baseUrl },
    },
  });

  const failingResults = await prisma.testResult.findMany({
    where: {
      runId: targetRunId,
      status: 'failed',
      // Skip archived test cases — they were intentionally removed and must not be resurrected
      testCase: { status: { not: 'archived' } },
    },
    include: { testCase: { select: { id: true, title: true } } },
    take: maxTests,
    orderBy: { createdAt: 'asc' },
  });

  await prisma.operatorTask.update({
    where: { id: triageTask.id },
    data: {
      status: 'succeeded',
      finishedAt: new Date(),
      outputJson: { runId: targetRunId, failingCount: failingResults.length },
    },
  });

  if (failingResults.length === 0) {
    console.log(`[operator-worker] repair: run ${targetRunId} has no failing tests`);
    return { healedCount: 0 };
  }

  const repairTasks = await Promise.all(
    failingResults.map((r) =>
      prisma.operatorTask.create({
        data: {
          jobId: opJob.id,
          type: 'repair',
          status: 'running',
          startedAt: new Date(),
          inputJson: { testResultId: r.id, testTitle: r.testCase?.title },
        },
      })
    )
  );

  // Upsert healing attempt records — if a previous repair run already created
  // attempt 1 for these results, reset it to queued rather than failing the unique constraint.
  const healAttempts = await Promise.all(
    failingResults.map((r) =>
      prisma.testHealingAttempt.upsert({
        where: {
          testResultId_attempt: { testResultId: r.id, attempt: 1 },
        },
        create: {
          run: { connect: { id: targetRunId! } },
          testResult: { connect: { id: r.id } },
          testCase: { connect: { id: r.testCase!.id } },
          attempt: 1,
          status: 'queued',
        },
        update: {
          status: 'queued',
          error: null,
          summary: null,
          diff: null,
        },
        select: { id: true },
      })
    )
  );

  await Promise.all(
    failingResults.map((r, i) =>
      enqueueSelfHeal({
        runId: targetRunId!,
        testResultId: r.id,
        testCaseId: r.testCase!.id,
        attemptId: healAttempts[i].id,
        projectId: opJob.projectId,
        totalFailed: failingResults.length,
        testTitle: r.testCase?.title ?? undefined,
        baseUrl,
      }).then(() => {
        console.log(
          `[operator-worker] repair: enqueued self-heal for "${r.testCase?.title}" (attempt ${healAttempts[i].id}, task ${repairTasks[i].id})`
        );
      })
    )
  );

  // taskMap: healingAttemptId → operatorTaskId (poll attempt status, not testResult status)
  const taskMap: Record<string, string> = Object.fromEntries(
    healAttempts.map((a, i) => [a.id, repairTasks[i].id])
  );
  const deadline = Date.now() + 20 * 60 * 1000;
  return await checkOrDelayRepairs(opJob.id, [...healAttempts.map((a) => a.id)], taskMap, deadline, reDelay);
}

async function checkOrDelayRepairs(
  jobId: string,
  remaining: string[],  // healingAttempt IDs
  taskMap: Record<string, string>,  // healingAttemptId → operatorTaskId
  deadline: number,
  reDelay: ReDelayFn
): Promise<{ healedCount: number }> {
  const attempts = await prisma.testHealingAttempt.findMany({
    where: { id: { in: remaining } },
    select: { id: true, status: true, error: true, testResultId: true },
  });

  const stillRemaining: string[] = [];
  for (const attempt of attempts) {
    if (attempt.status === 'succeeded' || attempt.status === 'failed' || attempt.status === 'skipped') {
      const taskId = taskMap[attempt.id];
      if (taskId) {
        const healed = attempt.status === 'succeeded';
        await prisma.operatorTask.update({
          where: { id: taskId },
          data: {
            status: healed ? 'succeeded' : 'failed',
            finishedAt: new Date(),
            error: healed ? null : (attempt.error ?? 'Self-heal did not fix the test'),
            outputJson: { healingAttemptId: attempt.id, finalStatus: attempt.status },
          },
        });
        if (healed) {
          const result = await prisma.testResult.findUnique({
            where: { id: attempt.testResultId },
            select: { runId: true },
          });
          if (result) {
            await recordArtifact({
              jobId,
              taskId,
              testRunId: result.runId,
              type: 'patch',
              path: `runs/${result.runId}/self-heal-patch-${attempt.id}.diff`,
              meta: { healingAttemptId: attempt.id, outcome: 'healed' },
            });
          }
        }
      }
    } else {
      stillRemaining.push(attempt.id);
    }
  }

  if (stillRemaining.length === 0) {
    // Count how many repairs succeeded across all invocations of this function
    const taskIds = Object.values(taskMap);
    const healed = await prisma.operatorTask.count({
      where: { id: { in: taskIds }, status: 'succeeded' },
    });
    return { healedCount: healed };
  }

  if (Date.now() > deadline) {
    await Promise.all(
      stillRemaining.map((resultId) => {
        const taskId = taskMap[resultId];
        if (!taskId) return;
        return prisma.operatorTask.update({
          where: { id: taskId },
          data: { status: 'failed', finishedAt: new Date(), error: 'Self-heal did not complete in time' },
        });
      })
    );
    return { healedCount: 0 }; // Timeout — partial results are still useful, don't throw
  }

  await reDelay(REPAIR_POLL_MS, { kind: 'wait_repairs', remaining: stillRemaining, taskMap, deadline });
}

// ── Discovery job ─────────────────────────────────────────────────────────────

async function runDiscoveryJob(opJob: OpJobCtx) {
  const ctx = (opJob.contextJson ?? {}) as Record<string, any>;
  const maxPages = Number(ctx.maxPages ?? 50);

  const project = await prisma.project.findUnique({
    where: { id: opJob.projectId },
    select: { repoUrl: true, ownerId: true, sharedSteps: true },
  });
  const repoUrl = project?.repoUrl?.trim() ?? '';
  const baseUrl: string | undefined =
    ctx.baseUrl ||
    (!isLikelyGitRepoUrl(repoUrl) && /^https?:\/\//i.test(repoUrl) ? repoUrl : undefined);

  if (!baseUrl) throw new Error('Discovery job requires a baseUrl or a non-git project.repoUrl');

  const requestHeaders = (ctx.headers ?? {}) as Record<string, string>;
  const cookieString = requestHeaders.Cookie || requestHeaders.cookie || '';

  const discoverTask = await prisma.operatorTask.create({
    data: {
      jobId: opJob.id,
      type: 'discover',
      status: 'running',
      startedAt: new Date(),
      inputJson: { baseUrl, maxPages },
    },
  });

  // ── Step 1: Playwright crawl ───────────────────────────────────────────────
  const { routes, forms, scans } = await discoverSite(baseUrl, [], { cookieString, maxPages });

  const checkedRoutes: Array<{ route: string; status: number; reachable: boolean }> = scans.map((s) => {
    const route = (() => { try { return new URL(s.url).pathname || '/'; } catch { return s.url; } })();
    return { route, status: s.status, reachable: s.status >= 200 && s.status < 400 };
  });

  const existingTests = await prisma.testCase.findMany({
    where: { projectId: opJob.projectId },
    select: { title: true },
  });
  const coveredHints = existingTests.map((t) => t.title.toLowerCase());

  const uncovered = checkedRoutes
    .filter((r) => r.reachable)
    .filter((r) => {
      const rl = r.route.toLowerCase();
      return !coveredHints.some((h) => h.includes(rl) || rl.includes(h));
    })
    .map((r) => r.route);

  // ── Step 2: Generate test plan from discovered scans ───────────────────────
  const plan = generatePlan(
    {
      env: { baseUrl },
      component: { id: opJob.projectId, type: 'UI' },
      requirement: { id: 'discovery', title: 'Auto-generated from discovery', priority: 'P2' },
      risks: { likelihood: 0.3, impact: 0.5 },
      discovered: { routes, forms, scans },
    },
    'sdet',
  );

  const planCases = plan.cases ?? (plan as any).testCases ?? [];

  // ── Step 3: Seed locator store from scan data so fill/click/upload steps ───
  // resolve to real selectors instead of "missing locator" stub comments.
  const discoveredStore = buildLocatorStoreFromScans(scans);
  const existingShared = (project?.sharedSteps as any) ?? {};
  const existingPages = existingShared.pages ?? {};
  const mergedPages: Record<string, any> = { ...existingPages };
  for (const [pagePath, bucket] of Object.entries(discoveredStore.pages)) {
    const existingPage = mergedPages[pagePath] ?? {};
    mergedPages[pagePath] = {
      ...existingPage,
      fields: { ...bucket.fields, ...(existingPage.fields ?? {}) },
      buttons: { ...bucket.buttons, ...(existingPage.buttons ?? {}) },
    };
  }
  const mergedSharedSteps = { ...existingShared, pages: mergedPages };

  await prisma.project.update({
    where: { id: opJob.projectId },
    data: { sharedSteps: mergedSharedSteps as any },
  });

  // ── Step 4: Write spec files to disk (with the seeded store active) ───────
  const ownerId = project?.ownerId ?? 'unknown';
  const outDir = path.join(GENERATED_ROOT, `playwright-ts-${ownerId}`, opJob.projectId);
  fsSync.mkdirSync(outDir, { recursive: true });

  const prevSharedStepsEnv = process.env.TM_PROJECT_SHARED_STEPS;
  process.env.TM_PROJECT_SHARED_STEPS = JSON.stringify(mergedSharedSteps);
  let specCount = 0;
  try {
    const result = await writeSpecsFromPlan(outDir, plan, 'playwright-ts');
    specCount = result.total;
  } finally {
    if (prevSharedStepsEnv === undefined) delete process.env.TM_PROJECT_SHARED_STEPS;
    else process.env.TM_PROJECT_SHARED_STEPS = prevSharedStepsEnv;
  }

  // ── Step 5: Upsert test cases to DB ───────────────────────────────────────
  let savedCount = 0;
  if (planCases.length > 0) {
    await prisma.$transaction(async (tx) => {
      for (const c of planCases) {
        const title = (c.title ?? c.name ?? 'Unnamed test') as string;
        const page = c.group?.page ?? '/';
        const key = `discovery/${opJob.projectId}/${page}#${title}`.slice(0, 255);
        const existing = await tx.testCase.findUnique({
          where: { projectId_key: { projectId: opJob.projectId, key } },
          select: { id: true, status: true },
        });
        if (existing?.status === 'archived') continue;
        if (existing) {
          await tx.testCase.update({ where: { id: existing.id }, data: { title } });
        } else {
          await tx.testCase.create({ data: { projectId: opJob.projectId, key, title } });
          savedCount++;
        }
      }
    });
  }

  // ── Step 6: Persist task result and artifact ───────────────────────────────
  const outputJson = {
    baseUrl,
    discoveredRoutes: checkedRoutes,
    uncoveredRoutes: uncovered,
    existingTestCount: existingTests.length,
    generatedTestCount: savedCount,
    specFileCount: specCount,
    outDir,
    summary: `Discovered ${checkedRoutes.length} routes; generated ${savedCount} new tests across ${specCount} spec files`,
  };

  await prisma.operatorTask.update({
    where: { id: discoverTask.id },
    data: { status: 'succeeded', finishedAt: new Date(), outputJson },
  });

  await recordArtifact({
    jobId: opJob.id,
    taskId: discoverTask.id,
    type: 'report',
    path: `jobs/${opJob.id}/discovery-routes.json`,
    meta: { routeCount: checkedRoutes.length, uncoveredCount: uncovered.length, generatedCount: savedCount },
  });

  console.log(
    `[operator-worker] discovery: ${checkedRoutes.length} routes, ${savedCount} new tests, ${specCount} spec files -> ${outDir}`,
  );
  return outputJson;

  console.log(
    `[operator-worker] discovery: ${checkedRoutes.length} routes, ${savedCount} new tests, ${specCount} spec files → ${outDir}`,
  );
}

// ── Security job ──────────────────────────────────────────────────────────────

async function runSecurityJob(opJob: OpJobCtx, reDelay: ReDelayFn) {
  const ctx = (opJob.contextJson ?? {}) as Record<string, any>;

  const project = await prisma.project.findUnique({
    where: { id: opJob.projectId },
    select: { repoUrl: true },
  });
  const repoUrl = project?.repoUrl?.trim() ?? '';
  const baseUrl: string =
    ctx.baseUrl || (!isLikelyGitRepoUrl(repoUrl) && /^https?:\/\//i.test(repoUrl) ? repoUrl : '');

  if (!baseUrl) throw new Error('Security job requires a baseUrl or a non-git project.repoUrl');

  const securityCtx: SecurityResumeCtx = {
    baseUrl,
    allowedHosts: ctx.allowedHosts ?? [new URL(baseUrl).hostname],
    allowedPorts: ctx.allowedPorts ?? [80, 443],
    maxDurationMinutes: Number(ctx.maxDurationMinutes ?? 10),
    enableActive: Boolean(ctx.enableActive ?? false),
    environment: typeof ctx.environment === 'string' ? ctx.environment : undefined,
    scanDepth: ctx.scanDepth === 'baseline' || ctx.scanDepth === 'standard' || ctx.scanDepth === 'deep' ? ctx.scanDepth : undefined,
    safeMode: typeof ctx.safeMode === 'boolean' ? ctx.safeMode : true,
    authProfiles: Array.isArray(ctx.authProfiles) ? ctx.authProfiles : [],
    apiFixtures: Array.isArray(ctx.apiFixtures) ? ctx.apiFixtures : [],
    expectedControls: Array.isArray(ctx.expectedControls) ? ctx.expectedControls : [],
    owaspCategories: Array.isArray(ctx.owaspCategories) ? ctx.owaspCategories : [],
    complianceFrameworks: Array.isArray(ctx.complianceFrameworks) ? ctx.complianceFrameworks : [],
  };

  const task = await prisma.operatorTask.create({
    data: {
      jobId: opJob.id,
      type: 'execute',
      status: 'running',
      startedAt: new Date(),
      inputJson: securityCtx,
    },
  });

  const needsSecurityApproval =
    Boolean(securityCtx.enableActive) ||
    securityCtx.scanDepth === 'deep' ||
    securityCtx.safeMode === false ||
    securityCtx.environment === 'prod';

  if (needsSecurityApproval && opJob.requestedBy) {
    const approval = await prisma.operatorApproval.create({
      data: {
        jobId: opJob.id,
        taskId: task.id,
        actionType: 'security_active_test',
        requestedBy: opJob.requestedBy,
        contextJson: {
          prompt: `Run approved security validation (${securityCtx.scanDepth ?? 'standard'} depth, ${securityCtx.environment ?? 'unspecified'} environment) against ${baseUrl}`,
          ...securityCtx,
        } as any,
        expiresAt: new Date(Date.now() + 30 * 60 * 1000),
      },
    });
    await prisma.operatorJob.update({ where: { id: opJob.id }, data: { status: 'blocked' } });
    // Release worker — resume will create and enqueue the scan once approved
    await reDelay(APPROVAL_POLL_MS, {
      kind: 'approval_security',
      approvalId: approval.id,
      taskId: task.id,
      deadline: Date.now() + 30 * 60 * 1000,
      securityCtx,
    });
  }

  // No approval required — create and enqueue scan directly
  await startSecurityScan(opJob.id, opJob.projectId, task.id, securityCtx, reDelay);
}

async function startSecurityScan(
  jobId: string,
  projectId: string,
  taskId: string,
  securityCtx: SecurityResumeCtx,
  reDelay: ReDelayFn
) {
  const scan = await prisma.securityScanJob.create({
    data: { projectId, status: 'queued', config: securityCtx as any },
  });

  await enqueueSecurityScan({ jobId: scan.id, projectId, ...securityCtx });

  const deadline = Date.now() + securityCtx.maxDurationMinutes * 60 * 1000 + 60_000;
  await checkOrDelayScan(scan.id, taskId, jobId, deadline, reDelay);
}

async function checkOrDelayApproval(
  opJob: OpJobCtx,
  phase: Extract<ResumePhase, { kind: 'approval_security' }>,
  reDelay: ReDelayFn
) {
  const approval = await prisma.operatorApproval.findUnique({
    where: { id: phase.approvalId },
    select: { status: true },
  });

  if (approval?.status === 'approved') {
    await prisma.operatorJob.update({ where: { id: opJob.id }, data: { status: 'running' } });
    await startSecurityScan(opJob.id, opJob.projectId, phase.taskId, phase.securityCtx, reDelay);
    return;
  }

  if (approval?.status === 'denied') {
    await prisma.operatorTask.update({
      where: { id: phase.taskId },
      data: { status: 'failed', finishedAt: new Date(), error: 'Approval denied' },
    });
    throw new Error('Approval denied for security active scan');
  }

  if (!approval || Date.now() > phase.deadline) {
    await prisma.operatorApproval.updateMany({
      where: { id: phase.approvalId, status: 'pending' },
      data: { status: 'expired' },
    });
    await prisma.operatorTask.update({
      where: { id: phase.taskId },
      data: { status: 'failed', finishedAt: new Date(), error: 'Approval timed out' },
    });
    throw new Error('Approval timed out for security active scan');
  }

  await reDelay(APPROVAL_POLL_MS, phase);
}

async function checkOrDelayScan(
  scanId: string,
  taskId: string,
  jobId: string,
  deadline: number,
  reDelay: ReDelayFn
) {
  const current = await prisma.securityScanJob.findUnique({
    where: { id: scanId },
    select: { status: true, summary: true, error: true, findings: { select: { severity: true } } },
  });

  if (!current) throw new Error(`SecurityScanJob ${scanId} not found`);

  if (current.status === 'completed' || current.status === 'failed') {
    const counts = current.findings.reduce<Record<string, number>>((acc, f) => {
      acc[f.severity] = (acc[f.severity] || 0) + 1;
      return acc;
    }, {});

    await prisma.operatorTask.update({
      where: { id: taskId },
      data: {
        status: current.status === 'completed' ? 'succeeded' : 'failed',
        finishedAt: new Date(),
        error: current.error ?? null,
        outputJson: { scanId, findingCounts: counts, summary: current.summary },
      },
    });

    // Record findings report as artifact
    await recordArtifact({
      jobId,
      taskId,
      type: 'report',
      path: `scans/${scanId}/findings.json`,
      meta: { findingCounts: counts, scanStatus: current.status },
    });

    if (current.status === 'failed') throw new Error(`Security scan failed: ${current.error}`);
    return;
  }

  if (Date.now() > deadline) {
    await prisma.operatorTask.update({
      where: { id: taskId },
      data: { status: 'failed', finishedAt: new Date(), error: `Security scan timed out`, outputJson: { scanId } },
    });
    throw new Error(`Security scan timed out (scanId=${scanId})`);
  }

  await reDelay(SCAN_POLL_MS, { kind: 'wait_scan', scanId, taskId, deadline });
}

// ── Legacy blocking approval (used by step-executor capabilities) ─────────────

/**
 * Creates a pending OperatorApproval and blocks until resolved or timed out.
 * Used by step-executor for terminal/git capability gates — these run within
 * a task's own execution window rather than holding the operator job thread.
 */
export async function requestApproval(opts: {
  jobId: string;
  taskId: string;
  requestedBy: string;
  actionType: 'run_terminal' | 'git_push' | 'patch_code' | 'security_active_test';
  description: string;
  context?: Record<string, unknown>;
  timeoutMs?: number;
}): Promise<'approved'> {
  const { jobId, taskId, requestedBy, actionType, description, context = {}, timeoutMs = 30 * 60 * 1000 } = opts;

  const approval = await prisma.operatorApproval.create({
    data: {
      jobId,
      taskId,
      actionType,
      requestedBy,
      contextJson: { prompt: description, ...context } as any,
      expiresAt: new Date(Date.now() + timeoutMs),
    },
  });

  await prisma.operatorJob.update({ where: { id: jobId }, data: { status: 'blocked' } });

  const interval = 4000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const current = await prisma.operatorApproval.findUnique({
      where: { id: approval.id },
      select: { status: true },
    });
    if (current?.status === 'approved') {
      await prisma.operatorJob.update({ where: { id: jobId }, data: { status: 'running' } });
      return 'approved';
    }
    if (current?.status === 'denied') {
      throw new Error(`Approval denied for job ${jobId}: "${description}"`);
    }
    await new Promise((r) => setTimeout(r, interval));
  }

  await prisma.operatorApproval.update({ where: { id: approval.id }, data: { status: 'expired' } });
  throw new Error(`Approval timed out for job ${jobId}: "${description}"`);
}

// ── Worker event hooks ────────────────────────────────────────────────────────

operatorWorker.on('failed', (job, err) => {
  console.error(`[operator-worker] job ${job?.id} failed:`, err);
});

operatorWorker.on('completed', (job) => {
  console.log(`[operator-worker] job ${job?.id} completed`);
});
