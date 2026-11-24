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
import { assessTestEvidence, allowsAutomaticRecovery, AUTONOMY_LEVELS, type AutonomyLevel } from '@testmind/core/workflow';
import {
  deriveDecisionsForFailureClassifications,
  recordOperatorDecisions,
  type FailureClassification,
} from '../lib/operator-decisions.js';
import {
  computeApplicationModelUpdate,
  normalizeApplicationModel,
  normalizeRouteHint,
  upsertTestLink,
} from '../lib/application-model.js';
import { applyApplicationModelMerge } from '../lib/application-model-store.js';
import {
  getOctokitForProject,
  setCommitStatus,
  buildRepairPrBody,
} from './github-writeback.js';
import { validatedEnv } from '../config/env.js';
import { requiresAutonomousScanApproval } from '../lib/security-approval-policy.js';
import { normalizeOpenSourceToolIds } from '../security/open-source-tools.js';
import { REPORT_ROOT } from '../lib/storageRoots.js';
import { validateUrl } from '../lib/safe-fetch.js';
import { computeCrawlKnowledgeUpdate, refreshStoryEvidence, incrementalSeedRoutes, routeClaimsFromTitles, type KnowledgeDiff } from '../lib/app-knowledge.js';
import { getProjectKnowledge, loadKnowledgeInputs, loadPlanInputs, recordUserStory, inspectRepository, resolveLocalRepository, recordDeclaredRoutes, recordFailureInvestigations, recordRepairOutcome } from '../lib/app-knowledge-store.js';
import { finalizeRepairVerification, describeVerification, REPAIR_FAILED } from '../lib/repair-verification.js';
import { buildQePlan, gateSuiteTests, grepInvertFor, testTitlesInSpec, type QePlan } from '../lib/qe-plan.js';
import { generateQeSuite } from '../testmind/pipeline/qe-codegen.js';
import { isCredentialRef } from '../lib/qe-credentials.js';
import { classifyFailure, decideRepair, repairPreservesObjective, type FailureInvestigation } from '../lib/failure-intel.js';
import { investigateFailure } from '../lib/investigator.js';
import { eligibleForCodeFix, isCodeFixConfig, appCodeFixEnabled, APP_CODE_FIX_DISABLED_REASON } from '../lib/qe-codefix.js';
import { createCodeFixProposal } from '../lib/qe-codefix-store.js';
import { operatorQueue } from './queue.js';
import {
  QeStageError,
  qeContextOf,
  ensureStages,
  startStage,
  finishStage,
  stageOutcome,
  currentStageKey,
  saveCheckpoint,
  finalizeQeRun,
  recordQeArtifact,
  recoverQeRuns,
  requireStageApproval,
  type QeContext,
  type QeStageKey,
} from './qe-orchestrator.js';

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
    if (opJob.status === 'canceled' || opJob.status === 'succeeded') return;
    const isQe = !!qeContextOf(opJob.contextJson);
    if (isQe && ['failed', 'partial', 'unverified', 'blocked'].includes(opJob.status)) return; // QE terminal states

    /** Release worker thread — re-queues the job with updated checkpoint after `ms`. */
    const reDelay: ReDelayFn = async (ms, phase) => {
      await job.updateData({ operatorJobId, resumePhase: phase } satisfies OperatorJobPayload);
      await job.moveToDelayed(Date.now() + ms, token);
      throw new DelayedError();
    };

    // Paused QE run: hold at the current checkpoint without doing any work.
    if (isQe && opJob.status === 'paused') {
      await reDelay(QE_PAUSE_POLL_MS, resumePhase ?? { kind: 'autonomous_qa', state: {} });
    }

    if (isQe) {
      try {
        if (resumePhase?.kind === 'autonomous_qa') {
          await runAutonomousQeJob(opJob, reDelay, resumePhase.state);
        } else {
          await prisma.operatorJob.updateMany({ where: { id: operatorJobId, status: 'queued' }, data: { status: 'running', startedAt: new Date() } });
          await runAutonomousQeJob(opJob, reDelay);
        }
      } catch (err: any) {
        if (err instanceof DelayedError) throw err;
        // Never rethrow: a QE run's outcome is recorded truthfully, not retried blindly.
        await finalizeQeRun(operatorJobId, { error: err?.message ?? String(err) }).catch(() => {});
      }
      await writeJobRollup(operatorJobId).catch(() => {});
      return;
    }

    try {
      const parentRunId = (opJob.contextJson as any)?.workflowParentId;
      if (parentRunId) {
        const { authorizedWorkflowContext } = await import('../lib/workflow-execution-policy.js');
        await authorizedWorkflowContext(parentRunId, opJob.projectId);
      }
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
        if (opJob.type === 'workflow') await advanceGraphJob(opJob, reDelay);
        else if (opJob.type === 'qa' && ctx.autonomous === true) await runAutonomousQaJob(opJob, reDelay);
        else if (opJob.type === 'qa')        await runQaJob(opJob, reDelay);
        else if (opJob.type === 'repair')    await runRepairJob(opJob, reDelay);
        else if (opJob.type === 'discovery') await runDiscoveryJob(opJob);
        else if (opJob.type === 'security')  await runSecurityJob(opJob, reDelay);
        else if (opJob.type === 'autonomousDev') { const { advanceDevAgentJob } = await import('./dev-agent-worker.js'); await advanceDevAgentJob(opJob, reDelay); }
        else throw new Error(`OperatorJob type '${opJob.type}' not yet implemented`);
      }

      // A Dev Agent run that ended 'unverified' (nothing executed, objective not met, or
      // blocked) must never surface as a 'succeeded' operator job.
      if (opJob.type === 'autonomousDev') {
        const devRun = await prisma.devAgentRun.findFirst({ where: { operatorJobId }, select: { status: true, error: true } });
        if (devRun?.status === 'unverified') {
          await prisma.operatorJob.updateMany({
            where: { id: operatorJobId, status: { not: 'canceled' } },
            data: { status: 'unverified', finishedAt: new Date(), error: devRun.error ?? 'Dev Agent run ended unverified - no executed, objective-aligned verification' },
          });
          await writeJobRollup(operatorJobId);
          return;
        }
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
  await prisma.operatorJob.updateMany({
    where: { id: jobId, status: { not: 'canceled' } },
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
  if (phase.kind === 'workflow_graph') {
    await advanceGraphJob(opJob, reDelay);
  } else if (phase.kind === 'autonomous_qa') {
    if (qeContextOf(opJob.contextJson)) await runAutonomousQeJob(opJob, reDelay, phase.state);
    else await runAutonomousQaJob(opJob, reDelay, phase.state);
  } else if (phase.kind === 'wait_run') {
    await checkOrDelayRun(phase.runId, phase.taskId, opJob.id, phase.deadline, reDelay);
  } else if (phase.kind === 'wait_repairs') {
    await checkOrDelayRepairs(opJob.id, phase.remaining, phase.taskMap, phase.deadline, reDelay);
  } else if (phase.kind === 'approval_security') {
    await checkOrDelayApproval(opJob, phase, reDelay);
  } else if (phase.kind === 'wait_scan') {
    await checkOrDelayScan(phase.scanId, phase.taskId, opJob.id, phase.deadline, reDelay);
  } else if (phase.kind === 'dev_agent_iterate') {
    const { advanceDevAgentJob } = await import('./dev-agent-worker.js');
    await advanceDevAgentJob(opJob, reDelay);
  }
}

async function advanceGraphJob(opJob: OpJobCtx, reDelay: ReDelayFn) {
  const { runWorkflowGraph } = await import('./workflow-runner.js');
  const result = await runWorkflowGraph(opJob).catch(async (error) => {
    await prisma.workflowRun.updateMany({ where: { operatorJobId: opJob.id, status: { in: ['queued', 'running'] } }, data: { status: 'failed', finishedAt: new Date(), error: 'Workflow could not resume its saved execution state. Review the operator error.' } });
    throw error;
  });
  if (result.status === 'pending') await reDelay(500, { kind: 'workflow_graph' });
  if (result.status === 'failed') throw new Error(result.error ?? 'Workflow evidence gate failed');
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
  repairRunId?: string;
  refreshPendingRepairs?: boolean;
  healedCount?: number;
  failedRepairResultIds?: string[];
  currentTestResultId?: string;
  attemptId?: string;
  repairTaskId?: string;
  targetSpec?: string | null;
  testTitle?: string | null;
  /** B3: Playwright --grep-invert for tests whose side effects were not approved. */
  grepInvert?: string;
  /** B3: titles excluded from execution (side effects not approved). */
  excludedTests?: string[];
  /** B5: test results failure intelligence cleared for automatic selector repair. */
  repairAllowList?: string[];
};

type AutonomousRunResult = {
  status: 'succeeded' | 'failed';
  error: string | null;
  summary: { passed: number; failed: number; errors: number; skipped: number; total: number; passedCaseIds: string[]; caseIds: string[] };
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
    select: { status: true, testCaseId: true },
  });
  const passed = results.filter((r) => r.status === 'passed').length;
  const failed = results.filter((r) => r.status === 'failed').length;
  const skipped = results.filter((r) => r.status === 'skipped').length;
  // Unknown/errored result states are execution failures, never passing evidence.
  const errors = results.length - passed - failed - skipped;
  return { passed, failed, errors, skipped, total: results.length,
    passedCaseIds: results.filter(r => r.status === 'passed').map(r => r.testCaseId),
    caseIds: results.map(r => r.testCaseId),
  };
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
    grepInvert?: string;
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
    ...((opJob.contextJson as any)?.workflowParentId ? { workflowRunId: (opJob.contextJson as any).workflowParentId } : {}),
    projectId: opJob.projectId,
    adapterId: opts.adapterId,
    baseUrl: opts.baseUrl,
    mode: 'ai',
    file: opts.file,
    grep: opts.grep ?? undefined,
    ...(isCredentialRef(ctx.qe?.credentialRef) ? { credentialRef: ctx.qe.credentialRef } : {}),
    ...(opts.grepInvert ? { grepInvert: opts.grepInvert } : {}),
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

  if (['succeeded', 'failed', 'canceled'].includes(run.status)) {
    const summary = await getRunSummary(runId);
    const requiredCaseIds = state.stage === 'wait_full_verify'
      ? (await getRunSummary(state.initialRunId)).caseIds
      : state.stage === 'wait_targeted_verify' && state.currentTestResultId
        ? [(await prisma.testResult.findUnique({ where: { id: state.currentTestResultId }, select: { testCaseId: true } }))?.testCaseId].filter(Boolean) as string[]
        : [];
    const gate = assessTestEvidence({ status: run.status, counts: summary, requiredCaseIds, passedCaseIds: summary.passedCaseIds });
    if (state.stage === 'wait_targeted_verify' && requiredCaseIds.length === 0) {
      gate.passed = false;
      gate.reasons.push('Targeted verification has no identifiable required test.');
    }
    const status = gate.passed ? 'succeeded' : 'failed';
    const error = gate.passed ? null : [run.error, ...gate.reasons].filter(Boolean).join(' ');
    await prisma.operatorTask.update({
      where: { id: taskId },
      data: {
        status,
        finishedAt: new Date(),
        error,
        outputJson: { phase: state.stage, testRunId: runId, finalStatus: status, executionStatus: run.status, summary, qualityGate: gate },
      },
    });
    await recordArtifact({
      jobId: opJob.id,
      taskId,
      testRunId: runId,
      type: 'report',
      path: `runs/${runId}/playwright-report.json`,
      meta: { phase: state.stage, finalStatus: status, executionStatus: run.status, qualityGate: gate },
    });
    return { status, error, summary };
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
  const { collectWorkflowRunEvidence } = await import('./workflow-evidence-collector.js');
  const { analyzeWorkflowEvidence } = await import('../lib/workflow-evidence.js');
  const rootCause = analyzeWorkflowEvidence(await collectWorkflowRunEvidence(opJob.projectId, { runId, source: 'ui' }, opJob.id, state.taskId!));
  const triageTask = await prisma.operatorTask.create({
    data: {
      jobId: opJob.id,
      type: 'triage',
      status: 'succeeded',
      startedAt: new Date(),
      finishedAt: new Date(),
      outputJson: { runId, classifications, rootCause, phase: 'autonomous-triage' } as any,
    },
  });

  await createInterventionsForClassifications(opJob, runId, triageTask.id, classifications);
  await recordOperatorDecisions({
    jobId: opJob.id,
    taskId: triageTask.id,
    decisions: deriveDecisionsForFailureClassifications(classifications),
  });

  const selfHealableIds = state.repairAllowList
    ? state.repairAllowList // B5 (QE): only failures investigated as safe selector repairs
    : classifications
      .filter((c) => c.type === 'self-heal' && rootCause.findings.some(f => f.caseId === c.testCaseId && f.verdict === 'automation-failure'))
      .map((c) => c.testResultId);

  if (selfHealableIds.length === 0) {
    throw new QeStageError('repair', 'blocked', 'Autonomous QA found failures that require human intervention');
  }

  const level = ((opJob.contextJson as any)?.autonomyLevel ?? 'autonomous-recovery') as AutonomyLevel;
  if (!allowsAutomaticRecovery(level)) throw new QeStageError('repair', 'blocked', `Automatic repair is disabled at autonomy level ${level}; testing evidence remains failed`);

  await startNextAutonomousRepair(opJob, reDelay, {
    ...state,
    remainingTestResultIds: selfHealableIds,
    repairRunId: runId,
    refreshPendingRepairs: false,
    healedCount: state.healedCount ?? 0,
    failedRepairResultIds: state.failedRepairResultIds ?? [],
  });
}

async function startNextAutonomousRepair(
  opJob: OpJobCtx,
  reDelay: ReDelayFn,
  state: AutonomousQaState
): Promise<void> {
  const level = ((opJob.contextJson as any)?.autonomyLevel ?? 'autonomous-recovery') as AutonomyLevel;
  if (!allowsAutomaticRecovery(level)) throw new QeStageError('repair', 'blocked', `Automatic repair is disabled at autonomy level ${level}`);
  const remaining = [...(state.remainingTestResultIds ?? [])];
  while (remaining.length > 0) {
    const testResultId = remaining.shift() as string;
    const result = await prisma.testResult.findFirst({
      where: {
        id: testResultId,
        runId: state.repairRunId ?? state.initialRunId,
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
        run: { connect: { id: state.repairRunId ?? state.initialRunId } },
        testResult: { connect: { id: testResultId } },
        testCase: { connect: { id: result.testCase.id } },
        attempt: attemptsSoFar + 1,
        status: 'queued',
      },
      select: { id: true },
    });

    await prisma.operatorTask.update({ where: { id: repairTask.id }, data: { inputJson: { phase: 'sequential-autonomous-repair', testResultId, healingAttemptId: attempt.id, testTitle: result.testCase.title } } });
    await enqueueSelfHeal({
      runId: state.repairRunId ?? state.initialRunId,
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
      testCaseId: true,
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
    if (qeContextOf(opJob.contextJson)) await recordRepairOutcome(opJob.projectId, attempt.testCaseId, 'repair_failed', attempt.error ?? `self-heal ended ${attempt.status}`).catch(() => {});
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
    if (qeContextOf(opJob.contextJson)) await recordRepairOutcome(opJob.projectId, attempt.testCaseId, 'repair_failed', `Repaired file rejected: ${message}`).catch(() => {});
    await startNextAutonomousRepair(opJob, reDelay, {
      ...state,
      failedRepairResultIds: [...(state.failedRepairResultIds ?? []), state.currentTestResultId],
    });
    return;
  }

  // B5 (QE): a repair may change HOW a test finds things, never WHAT it asserts.
  if (qeContextOf(opJob.contextJson)) {
    const specs = await prisma.testHealingAttempt.findUnique({ where: { id: attempt.id }, select: { originalSpec: true, repairedSpec: true } });
    const guard = specs?.originalSpec && specs?.repairedSpec
      ? repairPreservesObjective(specs.originalSpec, specs.repairedSpec)
      : { ok: false, reasons: ['original/repaired spec not recorded - objective preservation cannot be verified'] };
    if (!guard.ok) {
      if (specs?.originalSpec) await fs.writeFile(repairedSpec, specs.originalSpec, 'utf8'); // restore the original test
      const why = `Repair rejected - objective not preserved: ${guard.reasons.join('; ')}`;
      await prisma.operatorTask.update({ where: { id: state.repairTaskId }, data: { status: 'failed', finishedAt: new Date(), error: why, outputJson: { healingAttemptId: attempt.id, finalStatus: 'rejected', reasons: guard.reasons } } });
      await createHumanInterventionCandidate({ opJob, taskId: state.repairTaskId, runId: state.initialRunId, testResultId: state.currentTestResultId, healingAttemptId: attempt.id, reason: why });
      await recordRepairOutcome(opJob.projectId, attempt.testCaseId, 'repair_rejected', why).catch(() => {});
      await startNextAutonomousRepair(opJob, reDelay, { ...state, failedRepairResultIds: [...(state.failedRepairResultIds ?? []), state.currentTestResultId] });
      return;
    }
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
  // A repair succeeds only if its verification rerun passed; otherwise it is repair_failed
  // in the attempt, the repair task, its patch artifact and the Application Brain.
  const verified = (await finalizeRepairVerification(prisma, state.attemptId ? [state.attemptId] : [], result.summary as any, {
    runSucceeded: result.status === 'succeeded',
    detail: result.status === 'succeeded' ? undefined : `targeted verification rerun did not pass (${describeVerification(result.summary as any)})`,
  })) === 'succeeded';
  if (!verified && state.attemptId) {
    const reason = `${REPAIR_FAILED}: ${describeVerification(result.summary as any)}`;
    if (state.repairTaskId) {
      const task = await prisma.operatorTask.findUnique({ where: { id: state.repairTaskId }, select: { outputJson: true } });
      await prisma.operatorTask.update({
        where: { id: state.repairTaskId },
        data: { status: 'failed', error: reason, outputJson: { ...((task?.outputJson as any) ?? {}), finalStatus: REPAIR_FAILED } },
      }).catch(() => {});
    }
    const patches = await prisma.operatorArtifact.findMany({ where: { jobId: opJob.id, type: 'patch', metaJson: { path: ['healingAttemptId'], equals: state.attemptId } } });
    for (const p of patches) {
      await prisma.operatorArtifact.update({ where: { id: p.id }, data: { metaJson: { ...((p.metaJson as any) ?? {}), outcome: REPAIR_FAILED, verification: describeVerification(result.summary as any) } } }).catch(() => {});
    }
  }

  if (qeContextOf(opJob.contextJson) && state.attemptId) {
    const a = await prisma.testHealingAttempt.findUnique({ where: { id: state.attemptId }, select: { testCaseId: true } });
    if (a) await recordRepairOutcome(opJob.projectId, a.testCaseId, verified ? 'repaired_verified' : 'repair_failed',
      verified ? 'Selector repaired; the targeted re-run passed with the original assertions intact' : `Targeted re-run still failed: ${result.error ?? describeVerification(result.summary as any)}`).catch(() => {});
  }
  if (verified) {
    // A patch can fix other failures in the same file. Never submit their old
    // diagnostics again: verify the suite before deciding what still needs repair.
    await startAutonomousFullSuiteVerification(opJob, reDelay, {
      ...state,
      healedCount: (state.healedCount ?? 0) + 1,
      refreshPendingRepairs: Boolean(state.remainingTestResultIds?.length),
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
    grepInvert: state.grepInvert,
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
  if (result.status === 'succeeded') {
    if (state.failedRepairResultIds?.length) throw new QeStageError('repair', 'partial', 'Autonomous QA required repair or targeted verification failed; a full-suite pass cannot override it');
    return;
  }

  const runId = state.runId ?? state.initialRunId;
  const classifications = await classifyRunFailures(runId);
  if (state.refreshPendingRepairs && !state.failedRepairResultIds?.length) {
    const pending = await prisma.testResult.findMany({
      where: { id: { in: state.remainingTestResultIds ?? [] }, runId: state.repairRunId ?? state.initialRunId },
      select: { testCaseId: true },
    });
    const initial = await getRunSummary(state.initialRunId);
    // Bounded continuation: only previously pending cases with fresh failures.
    // Missing/skipped tests, new failures or failed repairs remain hard failures.
    if (result.summary.errors === 0 && result.summary.skipped === 0 &&
        initial.caseIds.every(id => result.summary.caseIds.includes(id)) &&
        classifications.length > 0 &&
        classifications.every(c => pending.some(p => p.testCaseId === c.testCaseId))) {
      await continueAutonomousAfterFailedRun(opJob, reDelay, state, runId);
      return;
    }
  }
  await createInterventionsForClassifications(opJob, runId, state.taskId ?? null, classifications);
  await recordOperatorDecisions({
    jobId: opJob.id,
    taskId: state.taskId ?? null,
    decisions: deriveDecisionsForFailureClassifications(classifications),
  });
  throw new QeStageError('repair', 'partial', 'Autonomous QA full-suite verification failed');
}

async function runAutonomousQaJob(opJob: OpJobCtx, reDelay: ReDelayFn, rawState?: Record<string, any>) {
  if (!validatedEnv.TM_AUTONOMOUS_QA_ENABLED) {
    throw new Error('Autonomous QA is not enabled');
  }
  const level = (opJob.contextJson as any)?.autonomyLevel;
  if (level !== undefined && !AUTONOMY_LEVELS.includes(level)) throw new Error('Unknown autonomy level');

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

// ── Autonomous QE (B1) ────────────────────────────────────────────────────────
// Drives the SAME pipeline functions runAutonomousQaJob uses (discovery/plan/codegen,
// createAutonomousRun, waitAutonomousRun, triage + sequential self-heal, verification),
// adding durable stages, DB checkpoints, plan-review hold, and truthful outcomes. Legacy
// autonomous QA jobs (no context.qe) never enter this path.

const QE_PAUSE_POLL_MS = 5_000;
const qePlanFile = (jobId: string) => path.join(REPORT_ROOT, 'qe', jobId, 'plan.json');

function qeMaxPages(qe: QeContext) {
  if (qe.inputKind === 'page') return 1;
  const fallback = qe.inputKind === 'user_story' ? 10 : 25;
  const n = Number(qe.maxPages ?? fallback);
  return Math.max(1, Math.min(Number.isFinite(n) ? Math.floor(n) : fallback, 50));
}

/** Every QE re-delay persists its checkpoint to the DB before releasing the worker. */
function qeReDelayFor(opJob: OpJobCtx, reDelay: ReDelayFn): ReDelayFn {
  return async (ms, phase) => {
    await saveCheckpoint(opJob.id, await currentStageKey(opJob.id), phase);
    return reDelay(ms, phase);
  };
}

async function setQeHold(jobId: string, hold: string | null) {
  const job = await prisma.operatorJob.findUnique({ where: { id: jobId }, select: { contextJson: true } });
  const ctx = { ...((job?.contextJson ?? {}) as Record<string, any>) };
  if (hold) ctx._qeHold = hold; else delete ctx._qeHold;
  await prisma.operatorJob.update({ where: { id: jobId }, data: { contextJson: ctx } });
}

function qeExecutionOutcome(result: AutonomousRunResult): { outcome: 'succeeded' | 'partial' | 'unverified'; reason: string } {
  const s = result.summary;
  if (s.total === 0) return { outcome: 'unverified', reason: `No tests were executed${result.error ? `: ${result.error}` : ''}` };
  if (result.status === 'succeeded') return { outcome: 'succeeded', reason: `${s.passed}/${s.total} tests passed` };
  return { outcome: 'partial', reason: `${s.passed}/${s.total} passed, ${s.failed} failed, ${s.errors} errored, ${s.skipped} skipped` };
}

async function runAutonomousQeJob(opJob: OpJobCtx, reDelay: ReDelayFn, rawState?: Record<string, any>) {
  const qe = qeContextOf(opJob.contextJson);
  if (!qe) throw new Error('Not an Autonomous QE run');
  const qReDelay = qeReDelayFor(opJob, reDelay);
  await ensureStages(opJob.id);
  try {
    const state = rawState as any;
    if (state?.qeStep === 'generate') await qeGenerateAndExecute(opJob, qReDelay);
    else if (state?.qeStep === 'execute_gate') await qeExecute(opJob, qReDelay, state.generatedDir);
    else if (state?.stage) await qeContinuePipeline(opJob, state as AutonomousQaState, qReDelay);
    else await qeStart(opJob, qe, qReDelay);
  } catch (err: any) {
    if (err instanceof DelayedError) throw err;
    if (err instanceof QeStageError) {
      await finishStage(opJob.id, err.stage, err.outcome, err.message);
    } else {
      const cur = await currentStageKey(opJob.id);
      if (cur) await finishStage(opJob.id, cur, 'failed', err?.message ?? String(err));
      else throw err;
    }
  }
  await qeReview(opJob);
  await finalizeQeRun(opJob.id);
}

/**
 * Inspects a run's repository (source routes + existing tests) as discovery evidence. "testmind" is
 * used only where a real local checkout exists; any other repository must be the one the project's
 * GitHub integration authorizes and is fetched as a shallow, run-scoped checkout deleted afterwards.
 */
async function qeInspectRunRepository(opJob: OpJobCtx, repo: { url: string; branch?: string }): Promise<string> {
  const jobId = opJob.id;
  let declared: Awaited<ReturnType<typeof inspectRepository>>;
  let label = repo.url;
  if (repo.url === 'testmind') {
    const { localTestmindRepoPath } = await import('./dev-agent-worktree.js');
    const root = localTestmindRepoPath();
    if (!root) throw new QeStageError('discovery', 'blocked', 'The "testmind" repository is not available on this server. Give the run a GitHub repository authorized by this project\'s GitHub integration, or test the application URL only.');
    declared = await inspectRepository(root, repo.url);
  } else {
    const { authorizeRunRepository, withRunCheckout } = await import('../lib/qe-run-access.js');
    const auth = await authorizeRunRepository(opJob.projectId, repo.url, repo.branch);
    if (!auth.ok) throw new QeStageError('discovery', 'blocked', `Repository access not authorized: ${(auth as { reason: string }).reason}`);
    label = `${auth.access.owner}/${auth.access.repo}@${auth.access.branch}`;
    try {
      declared = await withRunCheckout(jobId, auth.access, (root) => inspectRepository(root, label));
    } catch (err: any) {
      throw new QeStageError('discovery', 'failed', String(err?.message ?? err).slice(0, 600));
    }
  }
  await recordDeclaredRoutes(opJob.projectId, declared);
  await recordQeArtifact({
    jobId, stage: 'discovery', type: 'report', path: `qe/${jobId}/repository.json`,
    meta: { kind: 'repository', repo: label, inspectedAt: declared.inspectedAt, truncated: declared.truncated, uiRoutes: declared.uiRoutes.slice(0, 200), apiRoutes: declared.apiRoutes.slice(0, 300), uiRouteCount: declared.uiRoutes.length, apiRouteCount: declared.apiRoutes.length, testFileCount: declared.testFiles.length, testFiles: declared.testFiles.slice(0, 200) },
  });
  return `repository ${label}: ${declared.uiRoutes.length} UI route(s) and ${declared.apiRoutes.length} API route(s) declared in source, ${declared.testFiles.length} existing test file(s)${declared.truncated ? ' (inspection truncated at file limit)' : ''}`;
}

async function qeStart(opJob: OpJobCtx, qe: QeContext, qReDelay: ReDelayFn) {
  const jobId = opJob.id;
  await startStage(jobId, 'input');
  if (!validatedEnv.TM_AUTONOMOUS_QA_ENABLED) throw new QeStageError('input', 'failed', 'Autonomous QA is not enabled (TM_AUTONOMOUS_QA_ENABLED)');
  const level = (opJob.contextJson as any)?.autonomyLevel;
  if (level !== undefined && !AUTONOMY_LEVELS.includes(level)) throw new QeStageError('input', 'failed', 'Unknown autonomy level');

  let repositoryNote = '';
  if (qe.inputKind === 'repository') {
    const repo = qe.targetRepo ?? qe.input;
    await finishStage(jobId, 'input', 'succeeded', `Repository input accepted: ${repo}${qe.baseUrl ? ` (application URL ${qe.baseUrl})` : ''}`, { inputKind: qe.inputKind, targetRepo: repo, ...(qe.baseUrl ? { baseUrl: qe.baseUrl } : {}) });
    await startStage(jobId, 'discovery');
    repositoryNote = await qeInspectRunRepository(opJob, { url: repo });
    if (!qe.baseUrl) {
      await finishStage(jobId, 'discovery', 'succeeded', `${repositoryNote}. Declared routes are recorded as source facts, not runtime observations.`);
      await startStage(jobId, 'plan');
      throw new QeStageError('plan', 'blocked', 'No application URL to execute against - declared routes were recorded, but tests are only planned from observed behavior. Start the run with a base URL to discover and test the running application.');
    }
  }

  const baseUrl = qe.baseUrl ?? '';
  try {
    await validateUrl(baseUrl);
  } catch (err: any) {
    throw new QeStageError(qe.inputKind === 'repository' ? 'discovery' : 'input', 'failed', `Target URL rejected: ${err?.message ?? String(err)}`);
  }
  const maxPages = qeMaxPages(qe);
  const userStory = qe.inputKind === 'user_story' ? qe.input : undefined;
  if (qe.inputKind !== 'repository') await finishStage(jobId, 'input', 'succeeded', `${qe.inputKind} input accepted: ${baseUrl}${userStory ? ' (user story recorded)' : ''}`, { inputKind: qe.inputKind, baseUrl, maxPages, ...(userStory ? { userStory } : {}) });

  if (qe.inputKind !== 'repository') await startStage(jobId, 'discovery');
  // Repository-enabled URL runs: inspect the authorized repository's source as extra evidence.
  if (qe.inputKind !== 'repository' && qe.repository) repositoryNote = await qeInspectRunRepository(opJob, qe.repository);
  // Incremental, bounded discovery: revisit known pages that are missing, uncovered, or stale
  // first (never more than half the page budget), then let the crawler explore the rest.
  const before = await loadKnowledgeInputs(opJob.projectId);
  const scoped = qe.inputKind === 'page';
  // Routes existing tests target but the Brain has never observed are evidence the route exists;
  // revisiting them lets the crawl ground them in a real observation (bounded with the rest).
  const seedBudget = Math.floor(maxPages / 2);
  const failingClaims = routeClaimsFromTitles((before.testTitles ?? []).map((t) => t.title));
  const testedButUnobserved = [...new Set([...failingClaims, ...before.qaFailures.map((f) => f.routeHint), ...before.coverage.map((c) => c.routeHint), ...(before.testRouteClaims ?? [])])]
    .filter((r) => r.startsWith('/') && !before.store.pages[r]);
  const seedRoutes = scoped ? [] : [...new Set([
    ...incrementalSeedRoutes(before.store, new Set(before.coverage.map((c) => c.routeHint)), new Date().toISOString(), seedBudget),
    ...testedButUnobserved,
  ])].slice(0, seedBudget).map((r) => new URL(r, baseUrl).toString());
  const discoveryJob = { ...opJob, contextJson: { ...((opJob.contextJson ?? {}) as Record<string, any>), baseUrl, maxPages } };
  const planState = await discoverAndPlan(discoveryJob, { ...(userStory ? { requirement: { id: 'user-story', title: userStory.slice(0, 500), priority: 'P1' } } : {}), seedRoutes, scoped });
  const reachable = planState.checkedRoutes.filter((r) => r.reachable).length;
  const story = userStory ? await recordUserStory(opJob.projectId, userStory, jobId) : null;
  const knowledge = await getProjectKnowledge(opJob.projectId, { limit: 40 });
  const kd = planState.knowledgeDiff;
  const observedThisRun = new Set(kd?.pagesObserved ?? []);
  await recordQeArtifact({
    jobId, stage: 'discovery', type: 'report', path: `qe/${jobId}/discovery.json`,
    meta: { baseUrl, maxPages, seedRoutes: seedRoutes.length, routes: planState.checkedRoutes.slice(0, 200), uncoveredRoutes: planState.uncovered.slice(0, 200), existingTestCount: planState.existingTestCount },
  });
  await recordQeArtifact({
    jobId, stage: 'discovery', type: 'report', path: `qe/${jobId}/knowledge.json`,
    meta: {
      kind: 'knowledge',
      observedAt: planState.observedAt ?? null,
      // Observed this run (source: crawl, timestamped) - facts.
      observed: {
        pages: Object.values(knowledge.pages).filter((p) => observedThisRun.has(p.routeHint)).slice(0, 100).map((p) => ({
          route: p.routeHint, access: p.access ?? null, title: p.observed?.title ?? null,
          headings: p.observed?.headings.slice(0, 8) ?? [], actions: p.observed?.actions.slice(0, 12) ?? [], fields: p.observed?.fields.slice(0, 12) ?? [], forms: p.forms.length,
        })),
        apis: (kd?.apisObserved ?? []).slice(0, 100).map((key) => ({ key, ...knowledge.apis[key] })),
        thirdPartyHosts: kd?.thirdPartyHosts ?? [],
      },
      changes: { newPages: kd?.newPages ?? [], accessChanges: kd?.accessChanges ?? [], newApis: kd?.newApis ?? [], missingApis: kd?.missingApis ?? [] },
      inaccessible: { authRequired: kd?.authRequired ?? [], unreachable: kd?.unreachable ?? [] },
      // Expected behavior (source: user_story) - mapped to observed evidence only, never verified here.
      ...(story ? { story: { key: story.key, title: story.title, role: story.role ?? null, goal: story.goal ?? null, benefit: story.benefit ?? null, criteria: story.criteria } } : {}),
      coverage: knowledge.summary,
      testInventory: knowledge.testInventory,
      recommendations: knowledge.recommendations,
    } as any,
  });
  if (reachable === 0) throw new QeStageError('discovery', 'unverified', `No reachable pages discovered at ${baseUrl} (${planState.checkedRoutes.length} checked)`);
  const sm = knowledge.summary;
  const discoveryParts = [
    `${planState.checkedRoutes.length} page(s) crawled (${reachable} reachable${kd?.authRequired.length ? `, ${kd.authRequired.length} require auth` : ''}${kd?.newPages.length ? `, ${kd.newPages.length} new to the Brain` : ''})`,
    `${kd?.apisObserved.length ?? 0} API endpoint(s) observed${kd?.newApis.length ? ` (${kd.newApis.length} new)` : ''}`,
    `${sm.pages.uncovered.length} testable page(s) and ${sm.apis.uncovered.length} API(s) without tests`,
    ...(story ? [`story: ${story.criteria.filter((c) => c.status === 'elements_observed').length}/${story.criteria.length} criteria have observed elements`] : []),
    ...(repositoryNote ? [repositoryNote] : []),
  ];
  await finishStage(jobId, 'discovery', 'succeeded', discoveryParts.join('; '));

  await startStage(jobId, 'plan');
  await fs.mkdir(path.dirname(qePlanFile(jobId)), { recursive: true });
  await fs.writeFile(qePlanFile(jobId), JSON.stringify(planState));
  const cases = planState.planCases;
  const pages = new Set(cases.map((c: any) => c.group?.page ?? '/'));
  // Never repeat existing tests: mark which planned cases already exist (the same key the
  // generator upserts by) and their last result, so only genuinely new coverage counts as new.
  const caseKey = (c: any) => `discovery/${opJob.projectId}/${c.group?.page ?? '/'}#${(c.title ?? c.name ?? 'Unnamed test') as string}`.slice(0, 255);
  const existing = cases.length
    ? await prisma.testCase.findMany({ where: { projectId: opJob.projectId, key: { in: cases.map(caseKey) } }, select: { key: true, status: true, lastResultStatus: true } })
    : [];
  const existingByKey = new Map(existing.map((e) => [e.key, e]));
  const annotated = cases.slice(0, 200).map((c: any) => {
    const e = existingByKey.get(caseKey(c));
    return { title: c.title ?? c.name ?? 'Unnamed test', page: c.group?.page ?? '/', existing: !!e, lastResult: e?.lastResultStatus ?? null, archived: e?.status === 'archived' };
  });
  const newCount = cases.filter((c: any) => !existingByKey.has(caseKey(c))).length;
  const nextTests = knowledge.recommendations.filter((r) => r.actionable).slice(0, 15);
  const blockedItems = knowledge.recommendations.filter((r) => !r.actionable).slice(0, 15);
  // B3: the risk-prioritized, evidence-mapped plan. Persisted (DB artifact + file) so
  // generation, execution and repair can reference each test's original objective.
  const planInputs = await loadPlanInputs(opJob.projectId);
  const qePlan = buildQePlan({
    jobId, projectId: opJob.projectId, baseUrl, now: new Date().toISOString(), ...planInputs,
    generatorCases: cases.map((c: any) => ({ title: (c.title ?? c.name ?? 'Unnamed test') as string, page: (c.group?.page ?? '/') as string })),
  });
  await fs.writeFile(qePlanFile(jobId).replace(/plan\.json$/, 'qe-plan.json'), JSON.stringify(qePlan));
  await recordQeArtifact({
    jobId, stage: 'plan', type: 'plan', path: `qe/${jobId}/plan.json`,
    meta: {
      caseCount: cases.length, pageCount: pages.size, newCaseCount: newCount, existingCaseCount: cases.length - newCount,
      cases: annotated, nextTests, blocked: blockedItems,
      ...(userStory ? { userStory } : {}),
      qePlan,
    } as any,
  });
  if (cases.length === 0) throw new QeStageError('plan', 'unverified', 'The planner produced no test cases from the discovered pages');
  const ps = qePlan.summary;
  const planReason = `${ps.total} scenario(s): ${ps.byStatus.ready} ready (${ps.tiers.P1} P1), ${ps.byStatus.blocked_auth} blocked by authentication, ${ps.byStatus.blocked_unverifiable} unverifiable; ${ps.coverage.missing} missing vs ${ps.coverage.existing} existing coverage; ${ps.risk.destructive + ps.risk.sensitive} with side effects (${ps.needsApproval} executable now need approval)`;

  if (qe.planReview) {
    await finishStage(jobId, 'plan', 'succeeded', `${planReason}. Held for plan review before generation.`);
    await setQeHold(jobId, 'plan_review');
    await prisma.operatorJob.update({ where: { id: jobId }, data: { status: 'paused' } });
    await qReDelay(QE_PAUSE_POLL_MS, { kind: 'autonomous_qa', state: { qeStep: 'generate' } });
  }
  await finishStage(jobId, 'plan', 'succeeded', planReason);
  await qeGenerateAndExecute(opJob, qReDelay, planState);
}

async function qeGenerateAndExecute(opJob: OpJobCtx, qReDelay: ReDelayFn, given?: DiscoveryPlanState) {
  const jobId = opJob.id;
  await setQeHold(jobId, null);
  const planState: DiscoveryPlanState = given ?? JSON.parse(await fs.readFile(qePlanFile(jobId), 'utf8'));

  await startStage(jobId, 'generate');
  const generationStartedAt = Date.now() - 1000;
  const out = await generateFromPlan(opJob, planState);
  const generatedDir = out.outDir;
  const qeGen = await qeGenerateScenarioSuite(opJob, generatedDir);
  const specs = await collectSpecFiles(generatedDir);
  if (specs.length === 0) throw new QeStageError('generate', 'unverified', 'No spec files were generated');
  await validateAutonomousGeneratedDir(opJob, generatedDir);
  let writtenThisRun = 0;
  for (const file of specs) {
    const st = await fs.stat(file).catch(() => null);
    const fresh = !!st && st.mtimeMs >= generationStartedAt;
    if (fresh) writtenThisRun++;
    await recordQeArtifact({
      jobId, stage: 'generate', type: 'spec',
      path: path.relative(GENERATED_ROOT, file).replace(/\\/g, '/'),
      meta: { file: path.relative(generatedDir, file).replace(/\\/g, '/'), bytes: st?.size ?? null, writtenThisRun: fresh },
    });
  }
  const qeNote = qeGen ? `; ${qeGen.tests.length} scenario test(s) generated in ${qeGen.specFiles} QE spec file(s), ${qeGen.notGenerated.length} scenario(s) not generated (blocked or no honest assertion)` : '';
  await finishStage(jobId, 'generate', 'succeeded', `${writtenThisRun} spec file(s) written this run, ${out.generatedTestCount} new test case(s); suite under test: ${specs.length} spec file(s)${qeNote}`, { generatedDir, specFileCount: specs.length, writtenThisRun, newTestCases: out.generatedTestCount, ...(qeGen ? { qeTests: qeGen.tests.length, qeNotGenerated: qeGen.notGenerated.length } : {}) });

  await startStage(jobId, 'execute');
  await qeExecute(opJob, qReDelay, generatedDir);
}

/**
 * Executes the suite under test. Any test with side effects (sensitive or destructive) needs
 * explicit approval first; if it is denied or expires, those tests are excluded (never run)
 * and the stage can at best be 'partial'. Re-entrant: resumes here while approval is pending.
 */
async function qeExecute(opJob: OpJobCtx, qReDelay: ReDelayFn, generatedDir: string) {
  const jobId = opJob.id;
  const qePlan: QePlan | null = await fs.readFile(qePlanFile(jobId).replace(/plan\.json$/, 'qe-plan.json'), 'utf8').then(JSON.parse).catch(() => null);
  let excluded: string[] = [];
  if (qePlan) {
    const suiteTitles: string[] = [];
    for (const file of await collectSpecFiles(generatedDir)) suiteTitles.push(...testTitlesInSpec(await fs.readFile(file, 'utf8').catch(() => '')));
    const project = await prisma.project.findUnique({ where: { id: opJob.projectId }, select: { applicationModel: true } });
    const gated = gateSuiteTests(qePlan, [...new Set(suiteTitles)], normalizeApplicationModel(project?.applicationModel));
    if (gated.length) {
      const destructive = gated.some((g) => g.level === 'destructive');
      try {
        const gate = await requireStageApproval({
          jobId, stage: 'execute', gateKey: 'execute-side-effects',
          actionType: destructive ? 'destructive_test' : 'sensitive_action',
          description: `Run ${gated.length} test(s) with real side effects against ${qePlan.baseUrl}: ${gated.map((g) => `"${g.title}" (${g.reasons.join('; ')})`).join(', ')}`.slice(0, 2000),
          requestedBy: (opJob as any).requestedBy ?? 'system',
          context: { tests: gated },
        });
        if (gate.state === 'pending') {
          await qReDelay(APPROVAL_POLL_MS, { kind: 'autonomous_qa', state: { qeStep: 'execute_gate', generatedDir } });
        }
      } catch (err) {
        if (!(err instanceof QeStageError)) throw err;
        excluded = gated.map((g) => g.title); // denied/expired: fail closed - these tests do not run
        await startStage(jobId, 'execute');
      }
    }
  }
  const grepInvert = grepInvertFor(excluded);
  const { baseUrl, adapterId } = await resolveAutonomousContext(opJob);
  const initial = await createAutonomousRun(opJob, {
    taskType: 'execute',
    inputJson: { phase: 'initial-generated-suite', generatedDir, baseUrl, ...(excluded.length ? { excludedTests: excluded } : {}) },
    generatedDir, baseUrl, adapterId, file: generatedDir, grepInvert,
  });
  await qReDelay(RUN_POLL_MS, {
    kind: 'autonomous_qa',
    state: {
      stage: 'wait_initial_run', generatedDir, baseUrl, adapterId,
      initialRunId: initial.run.id, runId: initial.run.id, taskId: initial.task.id,
      deadline: Date.now() + AUTONOMOUS_RUN_TIMEOUT_MS,
      remainingTestResultIds: [], healedCount: 0, failedRepairResultIds: [],
      ...(excluded.length ? { grepInvert, excludedTests: excluded } : {}),
    } satisfies AutonomousQaState,
  });
}

/**
 * B4: turns the persisted B3 plan into executable QE specs inside the existing generated suite,
 * then records which scenarios became which tests (and which were not generated, and why).
 */
async function qeGenerateScenarioSuite(opJob: OpJobCtx, generatedDir: string) {
  const jobId = opJob.id;
  const planPath = qePlanFile(jobId).replace(/plan\.json$/, 'qe-plan.json');
  const qePlan: QePlan | null = await fs.readFile(planPath, 'utf8').then(JSON.parse).catch(() => null);
  if (!qePlan) return null;
  const qe = qeContextOf(opJob.contextJson);
  const project = await prisma.project.findUnique({ where: { id: opJob.projectId }, select: { applicationModel: true } });
  const store = normalizeApplicationModel(project?.applicationModel);
  const hasCredentials = isCredentialRef(qe && (qe as any).credentialRef);
  const result = generateQeSuite(qePlan, store, { hasCredentials });

  // Replace (not merge) the QE folder so removed scenarios don't linger as stale tests.
  const qeDir = path.join(generatedDir, 'qe');
  if (!isPathWithinOrEqual(generatedDir, qeDir)) throw new Error('QE output must stay inside the generated suite');
  await fs.rm(qeDir, { recursive: true, force: true });
  for (const file of result.files) {
    const abs = path.join(generatedDir, file.path);
    if (!isPathWithinOrEqual(qeDir, abs)) throw new Error(`Refusing to write outside the QE suite: ${file.path}`);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, file.content, 'utf8');
  }

  // The plan now points each generated scenario at its executable test (objectives preserved).
  const byScenario = new Map(result.tests.map((t) => [t.scenarioId, t]));
  qePlan.scenarios = qePlan.scenarios.map((s) => {
    const t = byScenario.get(s.id);
    if (!t) return s;
    return { ...s, status: s.status === 'blocked_auth' ? 'ready' : s.status, execution: { mode: 'generated_now', testTitle: t.testTitle } };
  });
  await fs.writeFile(planPath, JSON.stringify(qePlan));
  await recordQeArtifact({
    jobId, stage: 'generate', type: 'report', path: `qe/${jobId}/qe-generation.json`,
    meta: { kind: 'qe-generation', hasCredentials, tests: result.tests, notGenerated: result.notGenerated, files: result.files.map((f) => f.path) },
  });
  return { tests: result.tests, notGenerated: result.notGenerated, specFiles: result.files.filter((f) => f.path.endsWith('.spec.ts')).length };
}

/** Individual outcomes per generated scenario test ([qe:<id>] in the title), plus scenarios that did not run. */
async function qeScenarioOutcomes(jobId: string, runId: string, excludedTests: string[]) {
  const gen = await prisma.operatorArtifact.findFirst({ where: { jobId, type: 'report', metaJson: { path: ['kind'], equals: 'qe-generation' } }, orderBy: { createdAt: 'desc' }, select: { metaJson: true } });
  const meta = gen?.metaJson as any;
  if (!meta) return {};
  const results = await prisma.testResult.findMany({ where: { runId }, select: { status: true, message: true, testCase: { select: { title: true } } } });
  const outcomeFor = (testTitle: string) => {
    const id = /\[qe:([0-9a-f]+)\]/.exec(testTitle)?.[1];
    const r = results.find((x) => id && x.testCase.title.includes(`[qe:${id}]`));
    if (excludedTests.includes(testTitle)) return { status: 'not_run', message: 'side effects not approved' };
    if (!r) return { status: 'not_run', message: 'no result recorded for this test' };
    return { status: r.status, message: r.message ? r.message.slice(0, 500) : null };
  };
  return {
    scenarioOutcomes: (meta.tests ?? []).map((t: any) => ({ scenarioId: t.scenarioId, title: t.title, testTitle: t.testTitle, criteria: t.criteria, ...outcomeFor(t.testTitle) })),
    blockedScenarios: (meta.notGenerated ?? []).map((n: any) => ({ ...n, status: 'blocked' })),
  };
}

/**
 * B5: explains every failed test of a run (reusing the evidence collector/analyzer and the
 * investigator), records the investigations in the Brain, escalates suspected product defects,
 * and returns the failures that are safe to repair automatically.
 */
async function qeInvestigateFailures(opJob: OpJobCtx, runId: string, state: AutonomousQaState) {
  const jobId = opJob.id;
  const failed = await prisma.testResult.findMany({ where: { runId, status: { in: ['failed', 'error'] } }, select: { id: true, testCaseId: true, message: true, testCase: { select: { title: true } } }, take: 200 });
  const { collectWorkflowRunEvidence } = await import('./workflow-evidence-collector.js');
  const { analyzeWorkflowEvidence } = await import('../lib/workflow-evidence.js');
  const evidence = await collectWorkflowRunEvidence(opJob.projectId, { runId, source: 'ui' }, jobId, state.taskId!).catch(() => []);
  const analysis = analyzeWorkflowEvidence(evidence);
  const plan: QePlan | null = await fs.readFile(qePlanFile(jobId).replace(/plan\.json$/, 'qe-plan.json'), 'utf8').then(JSON.parse).catch(() => null);
  const project = await prisma.project.findUnique({ where: { id: opJob.projectId }, select: { applicationModel: true } });
  const store = normalizeApplicationModel(project?.applicationModel);
  const level = ((opJob.contextJson as any)?.autonomyLevel ?? 'autonomous-recovery') as AutonomyLevel;

  const investigations: FailureInvestigation[] = [];
  const decisions: Array<{ testResultId: string; action: string; reason: string }> = [];
  for (const r of failed) {
    const title = r.testCase.title;
    const scenario = plan?.scenarios.find((s) => s.execution.testTitle === title || title.includes(`[qe:${s.id}]`) || title.endsWith(s.execution.testTitle ?? '\u0000')) ?? null;
    const route = scenario?.route ?? routeClaimsFromTitles([title])[0] ?? null;
    const caseEvidence = evidence.filter((e) => e.caseId === r.testCaseId);
    const finding = analysis.findings.find((f) => f.caseId === r.testCaseId) ?? null;
    const inv = classifyFailure({
      testResultId: r.id, testCaseId: r.testCaseId, testTitle: title, message: r.message,
      investigator: investigateFailure({ message: r.message }),
      analyzer: finding ? { verdict: String(finding.verdict), hypotheses: finding.hypotheses, missingEvidence: finding.missingEvidence } : null,
      network: {
        serverErrors: [...new Set(caseEvidence.filter((e) => e.kind === 'network' && (e.status ?? 0) >= 500).map((e) => e.status!))],
        requestFailed: caseEvidence.filter((e) => e.kind === 'network' && e.message).map((e) => e.message!).slice(0, 10),
      },
      attachments: caseEvidence.filter((e) => e.kind === 'trace' || e.kind === 'screenshot').map((e) => ({ kind: e.kind, detail: `${e.kind} captured`, ...(e.artifactId ? { artifactId: e.artifactId } : {}) })),
      scenario: scenario ? { id: scenario.id, kind: scenario.kind, objective: scenario.objective, criteria: scenario.criteria } : null,
      route, page: route ? store.pages[route] ?? null : null,
    });
    const decision = decideRepair(inv, { autonomyAllowsRepair: allowsAutomaticRecovery(level), sideEffectsApproved: !(state.excludedTests ?? []).includes(title) });
    investigations.push(inv);
    decisions.push({ testResultId: r.id, action: decision.action, reason: decision.reason });
    if (decision.action === 'escalate') {
      await createHumanInterventionCandidate({ opJob, taskId: state.taskId ?? null, runId, testResultId: r.id, reason: `${inv.category === 'product_defect' ? 'Suspected product defect' : 'Test needs human attention'}: ${inv.explanation}`.slice(0, 1000), context: { category: inv.category, cause: inv.cause, confidence: inv.confidence } });
    }
  }
  await recordFailureInvestigations(opJob.projectId, investigations, runId).catch((err) => console.warn('[qe] failed to record investigations in Brain', err));
  for (const [i, d] of decisions.entries()) if (d.action !== 'auto_repair') await recordRepairOutcome(opJob.projectId, investigations[i].testCaseId, d.action === 'escalate' ? 'escalated' : 'held', d.reason).catch(() => {});

  // B6: evidence-backed suspected product defects may get a code-fix PROPOSAL from the Dev Agent
  // (isolated worktree, approval-gated, never applied/merged) - only when this run authorized it.
  const codeFix = (qeContextOf(opJob.contextJson) as any)?.codeFix;
  const proposals: Array<{ devAgentRunId: string; testTitle: string }> = [];
  // Release gate: autonomous application-code fixes are off unless explicitly enabled.
  const codeFixDisabled = isCodeFixConfig(codeFix) && !appCodeFixEnabled();
  if (codeFixDisabled) console.warn(`[qe] ${APP_CODE_FIX_DISABLED_REASON} - no code-fix proposal for job ${jobId}`);
  if (isCodeFixConfig(codeFix) && !codeFixDisabled) {
    for (const inv of investigations) {
      const eligibility = eligibleForCodeFix(inv);
      if (!eligibility.eligible || proposals.length >= 2) continue;
      const scenario = plan?.scenarios.find((s) => s.id === inv.scenarioId) ?? null;
      const p = await createCodeFixProposal({ qeJob: { id: jobId, projectId: opJob.projectId, requestedBy: opJob.requestedBy ?? null }, investigation: inv, criteria: scenario?.criteria ?? [], config: codeFix });
      await recordQeArtifact({
        jobId, stage: 'repair', type: 'pr_proposal', path: `qe/${jobId}/proposal-${p.devAgentRunId}.json`,
        meta: { devAgentRunId: p.devAgentRunId, operatorJobId: p.operatorJobId, testCaseId: inv.testCaseId, testTitle: inv.testTitle, scenarioId: inv.scenarioId, objective: inv.objective, criteria: scenario?.criteria ?? [], explanation: inv.explanation, eligibility: eligibility.reason, targetRepo: codeFix.targetRepo, testCommand: codeFix.testCommand ?? null },
      });
      proposals.push({ devAgentRunId: p.devAgentRunId, testTitle: inv.testTitle });
    }
  }

  const count = (c: string) => investigations.filter((i) => i.category === c).length;
  const allowList = decisions.filter((d) => d.action === 'auto_repair').map((d) => d.testResultId);
  const summary = `${investigations.length} failure(s) investigated: ${count('product_defect')} suspected product defect(s) escalated${proposals.length ? ` (${proposals.length} code-fix proposal(s) started for review)` : codeFixDisabled && count('product_defect') ? ' (automatic code fixes are disabled)' : ''}, ${count('test_defect')} test defect(s) (${allowList.length} safely auto-repairable), ${count('environment')} environment, ${count('blocked_inconclusive')} inconclusive`;
  await recordQeArtifact({
    jobId, stage: 'repair', type: 'report', path: `qe/${jobId}/failure-intel-${runId}.json`, testRunId: runId,
    meta: { kind: 'failure-intel', runId, summary, investigations, decisions, analyzerLimitation: analysis.limitation },
  });
  return { allowList, summary, productDefects: count('product_defect') };
}

async function qeContinuePipeline(opJob: OpJobCtx, state: AutonomousQaState, qReDelay: ReDelayFn) {
  const jobId = opJob.id;
  if (state.stage === 'wait_initial_run') {
    const result = await waitAutonomousRun(opJob, state, qReDelay);
    const exec = qeExecutionOutcome(result);
    if (state.excludedTests?.length && exec.outcome === 'succeeded') {
      exec.outcome = 'partial';
      exec.reason = `${exec.reason}; ${state.excludedTests.length} test(s) NOT executed - side effects not approved: ${state.excludedTests.join(', ')}`;
    } else if (state.excludedTests?.length) {
      exec.reason = `${exec.reason}; ${state.excludedTests.length} test(s) not executed (side effects not approved)`;
    }
    await recordQeArtifact({
      jobId, stage: 'execute', type: 'execution_result', testRunId: state.initialRunId,
      path: `runs/${state.initialRunId}/playwright-report.json`,
      meta: { phase: 'initial', status: result.status, summary: result.summary, error: result.error, ...(await qeScenarioOutcomes(jobId, state.initialRunId, state.excludedTests ?? [])) },
    });
    await finishStage(jobId, 'execute', exec.outcome, exec.reason, { runId: state.initialRunId, summary: result.summary });
    if (exec.outcome === 'unverified') return;
    if (result.status === 'succeeded') {
      await recordAutonomousFullSuitePass(opJob, state, result);
      await finishStage(jobId, 'repair', 'skipped', 'No failures to repair');
      return;
    }
    await startStage(jobId, 'repair');
    const intel = await qeInvestigateFailures(opJob, state.initialRunId, state);
    if (!intel.allowList.length) throw new QeStageError('repair', 'blocked', intel.summary);
    await continueAutonomousAfterFailedRun(opJob, qReDelay, { ...state, repairAllowList: intel.allowList }, state.initialRunId);
    return;
  }
  if (state.stage === 'wait_repair') return waitAutonomousRepair(opJob, qReDelay, state);
  if (state.stage === 'wait_targeted_verify') return waitAutonomousTargetedVerify(opJob, qReDelay, state);
  if (state.stage === 'wait_full_verify') {
    await waitAutonomousFullSuiteVerify(opJob, qReDelay, state);
    const runId = state.runId ?? state.initialRunId;
    await recordQeArtifact({
      jobId, stage: 'repair', type: 'execution_result', testRunId: runId,
      path: `runs/${runId}/playwright-report.json`,
      meta: { phase: 'full-suite-verification', summary: await getRunSummary(runId), ...(await qeScenarioOutcomes(jobId, runId, state.excludedTests ?? [])) },
    });
    await finishStage(jobId, 'repair', 'succeeded', `${state.healedCount ?? 0} test(s) repaired; full suite re-verified passing`);
  }
}

async function qeReview(opJob: OpJobCtx) {
  const jobId = opJob.id;
  const exec = await stageOutcome(jobId, 'execute');
  if (!exec || ['pending', 'skipped', 'canceled', 'running'].includes(exec)) return;

  const repairs = await prisma.operatorTask.findMany({ where: { jobId, type: 'repair' }, orderBy: { createdAt: 'asc' } });
  const recorded = await prisma.operatorArtifact.count({ where: { jobId, type: 'repair_attempt' } });
  if (!recorded) {
    for (const r of repairs) {
      await recordQeArtifact({
        jobId, stage: 'repair', type: 'repair_attempt', path: `jobs/${jobId}/repair/${r.id}`,
        meta: { taskId: r.id, status: r.status, error: r.error, input: r.inputJson, output: r.outputJson },
      });
    }
  }

  if (!(await startStage(jobId, 'review'))) return;
  const stages = await prisma.operatorTask.findMany({ where: { jobId, type: 'stage' }, orderBy: { stageOrder: 'asc' }, select: { stageKey: true, outcome: true, outcomeReason: true } });
  const runTasks = await prisma.operatorTask.findMany({ where: { jobId, testRunId: { not: null } }, orderBy: { createdAt: 'asc' }, select: { type: true, testRunId: true, status: true, inputJson: true } });
  await recordQeArtifact({
    jobId, stage: 'review', type: 'report', path: `qe/${jobId}/review.json`,
    meta: {
      stages: stages.map((s) => ({ stage: s.stageKey, outcome: s.outcome, reason: s.outcomeReason })),
      testRuns: runTasks.map((t) => ({ taskType: t.type, testRunId: t.testRunId, status: t.status, phase: (t.inputJson as any)?.phase ?? null })),
      repairAttempts: repairs.length,
    },
  });
  await finishStage(jobId, 'review', 'succeeded', 'Results compiled for review. PR proposals can be prepared here; publishing always requires explicit approval.');
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
    ...(ctx.workflowParentId ? { workflowRunId: ctx.workflowParentId } : {}),
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
  const triageTask = await prisma.operatorTask.create({
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
  await recordOperatorDecisions({
    jobId: opJob.id,
    taskId: triageTask.id,
    decisions: deriveDecisionsForFailureClassifications(classifications),
  });

  const selfHealable = classifications.filter((c) => c.type === 'self-heal');
  const defects      = classifications.filter((c) => c.type === 'defect');
  const blocked      = classifications.filter((c) => c.type === 'blocked');

  // Route self-healable failures into Journey 1 via the existing repair job
  if (selfHealable.length > 0 && (!ctx.workflowParentId || allowsAutomaticRecovery(ctx.autonomyLevel))) {
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
        ...(ctx.workflowParentId ? { workflowRunId: ctx.workflowParentId } : {}),
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

              // Persist executionAfter; a repair succeeds only if this retest passed.
              const retestOutcome = await finalizeRepairVerification(prisma, attempts.map((a) => a.id), retestSummary);
              if (retestOutcome === REPAIR_FAILED) console.warn(`[operator-worker] repair_failed: ${describeVerification(retestSummary)} - no PR proposal for job ${opJob.id}`);

              const files = retestOutcome === REPAIR_FAILED ? [] : await Promise.all(
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

                // B7: autonomous writeback never publishes on its own. Repairs become a PR proposal
                // that waits for explicit approval bound to the exact repo/branch/diff.
                void branchName; void prTitle; void prBody;
                if (minConf >= 80) {
                  const { createPrProposal } = await import('../lib/pr-publication-store.js');
                  const proposal = await createPrProposal({ projectId: opJob.projectId, jobId: opJob.id, kind: 'test_repair', source: { type: 'legacy_writeback', attemptIds: attempts.map((a) => a.id) }, actor: opJob.requestedBy ?? 'system' });
                  console.log(`[operator-worker] repaired tests ready for review - PR proposal ${proposal.id} is ${proposal.status}; publishing requires explicit approval`);
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
async function classifyRunFailures(runId: string): Promise<FailureClassification[]> {
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
      msg.includes('no tests found') ||
      msg.includes('no test files found') ||
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
    failingResults.map(async (r, i) => {
      await prisma.operatorTask.update({ where: { id: repairTasks[i].id }, data: { inputJson: { testResultId: r.id, healingAttemptId: healAttempts[i].id } } });
      return enqueueSelfHeal({
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
      });
    }
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

// Unchanged behavior for every existing caller: discover+plan then generate, back to back.
// Split only so an Autonomous QE run can checkpoint (and optionally hold for plan review)
// between planning and spec generation.
async function runDiscoveryJob(opJob: OpJobCtx) {
  return generateFromPlan(opJob, await discoverAndPlan(opJob));
}

// Serializable hand-off between the two halves (persisted as the QE plan artifact).
type DiscoveryPlanState = {
  baseUrl: string;
  ownerId: string;
  discoverTaskId: string;
  checkedRoutes: Array<{ route: string; status: number; reachable: boolean }>;
  uncovered: string[];
  existingTestCount: number;
  plan: any;
  planCases: any[];
  mergedSharedSteps: Record<string, any>;
  applicationModelDiff: unknown;
  /** B2: what this crawl added to / changed in the Application Brain. */
  knowledgeDiff?: KnowledgeDiff;
  observedAt?: string;
};

async function discoverAndPlan(opJob: OpJobCtx, opts: {
  requirement?: { id: string; title: string; priority?: string };
  /** B2: known routes to revisit first (incremental discovery). */
  seedRoutes?: string[];
  /** B2: a deliberately partial crawl (e.g. one page) - pages it never tried to visit are not counted as missing. */
  scoped?: boolean;
} = {}): Promise<DiscoveryPlanState> {
  const ctx = (opJob.contextJson ?? {}) as Record<string, any>;
  const maxPages = Number(ctx.maxPages ?? 50);

  const project = await prisma.project.findUnique({
    where: { id: opJob.projectId },
    select: { repoUrl: true, ownerId: true, sharedSteps: true, applicationModel: true },
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
  let graphOptions = {};
  if (ctx.workflowParentId) {
    const { authorizedWorkflowContext } = await import('../lib/workflow-execution-policy.js');
    const { validateWorkflowTarget } = await import('../lib/workflow-http.js');
    const scope = await authorizedWorkflowContext(ctx.workflowParentId, opJob.projectId);
    await validateWorkflowTarget(baseUrl, scope.environment);
    graphOptions = { signal: AbortSignal.timeout(AUTONOMOUS_RUN_TIMEOUT_MS), validateRequest: async (url: string) => { await validateWorkflowTarget(url, scope.environment ?? { baseUrl }); } };
  }
  const { routes, forms, scans, apis: observedApiCalls, thirdPartyHosts, redirects, attempted } = await discoverSite(baseUrl, opts.seedRoutes ?? [], { cookieString, maxPages, ...graphOptions });

  // ── Project Memory: read prior application-model facts, diff against this cycle's forms.
  // Forms without a routeHint can't be attributed to a page and are skipped. Log/diff only -
  // does not change the crawl itself (see the plan: this is deliberately not a skip/
  // deprioritize decision, that belongs to a later autonomous-rediscovery phase).
  const formsByRoute: Record<string, Array<{ selector: string; action?: string; fields: typeof forms[number]['fields'] }>> = {};
  for (const f of forms) {
    if (!f.routeHint) continue;
    const route = normalizeRouteHint(f.routeHint);
    (formsByRoute[route] ??= []).push({ selector: f.selector, action: f.action, fields: f.fields });
  }
  const observedAt = new Date().toISOString();
  const priorModel = normalizeApplicationModel(project?.applicationModel);
  const applicationModelUpdate = computeApplicationModelUpdate(priorModel, formsByRoute, observedAt);
  // B2: every crawled page (not only pages with forms) gets access state + observed elements,
  // captured API traffic is merged with provenance, and recorded stories are re-mapped against
  // the fresh evidence. A scoped crawl doesn't count unvisited pages as missing.
  const knowledge = computeCrawlKnowledgeUpdate(applicationModelUpdate.next, {
    scans, apiCalls: observedApiCalls ?? [], thirdPartyHosts, redirects, observedAt, runId: opJob.id,
  });
  // A bounded crawl only learns that a page is missing if it actually requested it. Known pages
  // this crawl never tried keep their prior miss count (scoped runs never count misses at all).
  const requested = new Set((attempted ?? []).map((u) => { try { return normalizeRouteHint(new URL(u).pathname || '/'); } catch { return u; } }));
  const observedNow = new Set(knowledge.diff.pagesObserved);
  for (const route of applicationModelUpdate.diff.missingPages) {
    if (observedNow.has(route)) continue; // seen this crawl: misses already reset to 0
    if (!opts.scoped && requested.has(route)) continue; // requested but not seen: a real miss
    const prior = priorModel.pages[route];
    if (prior && knowledge.next.pages[route]) knowledge.next.pages[route] = { ...knowledge.next.pages[route], consecutiveMisses: prior.consecutiveMisses };
  }
  const nextApplicationModel = refreshStoryEvidence(knowledge.next, observedAt);
  console.log(
    `[operator-worker] discovery application-model diff for project ${opJob.projectId}:`,
    `new=${applicationModelUpdate.diff.newPages.length}`,
    `changed=${applicationModelUpdate.diff.changedPages.length}`,
    `unchanged=${applicationModelUpdate.diff.unchangedPages.length}`,
    `missing=${applicationModelUpdate.diff.missingPages.length}`
  );

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
      requirement: (opts.requirement ?? { id: 'discovery', title: 'Auto-generated from discovery', priority: 'P2' }) as any,
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
    data: { sharedSteps: mergedSharedSteps as any, applicationModel: nextApplicationModel as any },
  });

  return {
    baseUrl,
    ownerId: project?.ownerId ?? 'unknown',
    discoverTaskId: discoverTask.id,
    checkedRoutes,
    uncovered,
    existingTestCount: existingTests.length,
    plan,
    planCases,
    mergedSharedSteps,
    applicationModelDiff: applicationModelUpdate.diff,
    knowledgeDiff: knowledge.diff,
    observedAt,
  };
}

async function generateFromPlan(opJob: OpJobCtx, s: DiscoveryPlanState) {
  const ctx = (opJob.contextJson ?? {}) as Record<string, any>;
  const { baseUrl, plan, planCases, mergedSharedSteps, checkedRoutes, uncovered } = s;
  const discoverTask = { id: s.discoverTaskId };
  const existingTests = { length: s.existingTestCount };
  const applicationModelUpdate = { diff: s.applicationModelDiff as any };

  // ── Step 4: Write spec files to disk (with the seeded store active) ───────
  const ownerId = s.ownerId;
  const outDir = path.join(GENERATED_ROOT, `playwright-ts-${ownerId}`, opJob.projectId, ...(ctx.workflowParentId ? [String(ctx.generatedScope).replace(/[^a-zA-Z0-9_-]/g, '_')] : []));
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
  // Application Brain v1 (Ticket AB.4): route is already a local variable here (`page`) and
  // discarded into an opaque compound key today - this collects it so a testLink can be
  // written per newly-created case below, once each case has a real id. Only new cases, per
  // MUST HAVE #7 ("written once, at creation time") - not re-linked on every rediscovery of an
  // already-known case, which would multiply CAS writes for no informational gain.
  const newlyCreatedLinks: Array<{ testCaseId: string; routeHint: string }> = [];
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
          const created = await tx.testCase.create({ data: { projectId: opJob.projectId, key, title }, select: { id: true } });
          savedCount++;
          newlyCreatedLinks.push({ testCaseId: created.id, routeHint: normalizeRouteHint(page) });
        }
      }
    });
  }

  // Best-effort, outside the transaction above - a CAS merge can take several retries under
  // concurrent writers, which isn't worth holding the TestCase transaction open for. A failed
  // link never blocks case creation, which has already committed by this point; the case just
  // falls back to AB.2's "inferred" coverage confidence instead of "linked".
  for (const link of newlyCreatedLinks) {
    try {
      await applyApplicationModelMerge(opJob.projectId, (store) =>
        upsertTestLink(store, link.testCaseId, link.routeHint, new Date().toISOString())
      );
    } catch (err) {
      console.warn(`[operator-worker] failed to write Application Brain testLink for case ${link.testCaseId}:`, err);
    }
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
    applicationModelDiff: applicationModelUpdate.diff,
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
    openSourceToolIds: normalizeOpenSourceToolIds(
      Array.isArray(ctx.openSourceToolIds) ? ctx.openSourceToolIds : undefined
    ),
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

  const needsSecurityApproval = requiresAutonomousScanApproval({
    environment: securityCtx.environment,
    scanDepth: securityCtx.scanDepth,
    enableActive: Boolean(securityCtx.enableActive),
    safeMode: securityCtx.safeMode,
  });

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
  reDelay: ReDelayFn,
  approvalGranted = false
) {
  const scan = await prisma.securityScanJob.create({
    data: { projectId, status: 'queued', config: securityCtx as any },
  });

  await enqueueSecurityScan({ jobId: scan.id, projectId, ...securityCtx, approvalGranted });

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
    await startSecurityScan(opJob.id, opJob.projectId, phase.taskId, phase.securityCtx, reDelay, true);
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
  // Optional: unset for a job-level gate with no OperatorTask of its own (e.g. a one-time
  // "authorize this run" check). OperatorApproval.taskId is itself an optional FK - passing
  // a non-task id here (such as the jobId) violates OperatorApproval_taskId_fkey.
  taskId?: string;
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

// ── Autonomous QE recovery (B1) ───────────────────────────────────────────────
// A QE run whose BullMQ job was lost or failed (e.g. "stalled more than allowable limit"
// across a worker restart) is re-enqueued from its DB checkpoint, so completed stages are
// never repeated. Runs with a live waiting/delayed/active job are untouched.
async function recoverQeRunsOnce() {
  try {
    const ids = await recoverQeRuns({
      getJobState: async (id) => {
        const j = await operatorQueue.getJob(id);
        return j ? await j.getState() : null;
      },
      removeJob: async (id) => {
        const j = await operatorQueue.getJob(id);
        await j?.remove();
      },
      enqueue: async (id, phase) => {
        await operatorQueue.add(
          'execute',
          { operatorJobId: id, ...(phase ? { resumePhase: phase as ResumePhase } : {}) } satisfies OperatorJobPayload,
          { jobId: id, removeOnComplete: true, removeOnFail: false, attempts: 1 }
        );
      },
    });
    if (ids.length) console.log(`[operator-worker] recovered ${ids.length} Autonomous QE run(s) from DB checkpoint: ${ids.join(', ')}`);
  } catch (err) {
    console.warn('[operator-worker] Autonomous QE recovery sweep failed', err);
  }
}
if (process.env.TM_QE_RECOVERY !== '0') {
  setTimeout(recoverQeRunsOnce, 5_000).unref();
  setInterval(recoverQeRunsOnce, 60_000).unref();
}
export { recoverQeRunsOnce };
