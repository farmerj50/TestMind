import { Worker, Job, DelayedError } from 'bullmq';
import path from 'path';
import fsSync from 'fs';
import { prisma } from '../prisma.js';
import { redis } from './redis.js';
import { enqueueRun, enqueueSelfHeal, enqueueSecurityScan } from './queue.js';
import { CURATED_ROOT, agentSuiteId } from '../testmind/curated-store.js';
import { GENERATED_ROOT } from '../lib/storageRoots.js';
import type { OperatorJobPayload, ResumePhase, SecurityResumeCtx } from './queue.js';
import { createStepRunner } from './step-executor.js';
import { runBrowserCapability } from './capabilities/browser-cap.js';

export { createStepRunner };

// ── Poll intervals (ms) ───────────────────────────────────────────────────────
const RUN_POLL_MS      = 3_000;
const SCAN_POLL_MS     = 5_000;
const REPAIR_POLL_MS   = 5_000;
const APPROVAL_POLL_MS = 4_000;

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

        if (opJob.type === 'qa')        await runQaJob(opJob, reDelay);
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

const isLikelyGitRepo = (url?: string | null) => {
  if (!url) return false;
  const t = url.trim();
  return t.endsWith('.git') || t.startsWith('git@') || /github\.com|gitlab\.com|bitbucket\.org/.test(t);
};

// ── Resume dispatcher ─────────────────────────────────────────────────────────

async function handleResume(opJob: OpJobCtx, phase: ResumePhase, reDelay: ReDelayFn) {
  if (phase.kind === 'wait_run') {
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

async function runQaJob(opJob: OpJobCtx, reDelay: ReDelayFn) {
  const ctx = (opJob.contextJson ?? {}) as Record<string, any>;

  const project = await prisma.project.findUnique({
    where: { id: opJob.projectId },
    select: { repoUrl: true, ownerId: true },
  });
  const explicitMode = ctx.mode as string | undefined;
  const inferredMode = explicitMode ?? (isLikelyGitRepo(project?.repoUrl) ? 'regular' : 'ai');
  const repoUrl = project?.repoUrl?.trim() ?? '';
  const inferredBaseUrl: string | undefined =
    ctx.baseUrl ||
    (!isLikelyGitRepo(repoUrl) && /^https?:\/\//i.test(repoUrl) ? repoUrl : undefined);

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
    await runRepairJob(
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

async function runRepairJob(opJob: OpJobCtx, reDelay: ReDelayFn) {
  const ctx = (opJob.contextJson ?? {}) as Record<string, any>;
  const maxTests = Number(ctx.maxTests ?? 10);

  const project = await prisma.project.findUnique({
    where: { id: opJob.projectId },
    select: { repoUrl: true },
  });
  const repoUrl = project?.repoUrl?.trim() ?? '';
  const baseUrl: string | undefined =
    ctx.baseUrl ||
    (!isLikelyGitRepo(repoUrl) && /^https?:\/\//i.test(repoUrl) ? repoUrl : undefined);

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
    return;
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
  await checkOrDelayRepairs(opJob.id, [...healAttempts.map((a) => a.id)], taskMap, deadline, reDelay);
}

async function checkOrDelayRepairs(
  jobId: string,
  remaining: string[],  // healingAttempt IDs
  taskMap: Record<string, string>,  // healingAttemptId → operatorTaskId
  deadline: number,
  reDelay: ReDelayFn
) {
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

  if (stillRemaining.length === 0) return;

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
    return; // Timeout — partial results are still useful, don't throw
  }

  await reDelay(REPAIR_POLL_MS, { kind: 'wait_repairs', remaining: stillRemaining, taskMap, deadline });
}

// ── Discovery job ─────────────────────────────────────────────────────────────

async function runDiscoveryJob(opJob: OpJobCtx) {
  const ctx = (opJob.contextJson ?? {}) as Record<string, any>;
  const maxPages = Number(ctx.maxPages ?? 20);

  const project = await prisma.project.findUnique({
    where: { id: opJob.projectId },
    select: { repoUrl: true, ownerId: true },
  });
  const repoUrl = project?.repoUrl?.trim() ?? '';
  const baseUrl: string | undefined =
    ctx.baseUrl ||
    (!isLikelyGitRepo(repoUrl) && /^https?:\/\//i.test(repoUrl) ? repoUrl : undefined);

  if (!baseUrl) throw new Error('Discovery job requires a baseUrl or a non-git project.repoUrl');

  const discoverTask = await prisma.operatorTask.create({
    data: {
      jobId: opJob.id,
      type: 'discover',
      status: 'running',
      startedAt: new Date(),
      inputJson: { baseUrl, maxPages },
    },
  });

  const ctx2 = { jobId: opJob.id, taskId: discoverTask.id, projectId: opJob.projectId, baseUrl };

  const homeResult = await runBrowserCapability({ action: 'navigate', target: baseUrl }, ctx2);
  if (!homeResult.success) throw new Error(`Discovery: cannot reach ${baseUrl}: ${homeResult.error}`);

  const visited = new Set<string>([baseUrl]);
  const discovered: string[] = ['/'];

  let rawHtml = '';
  try {
    const res = await fetch(baseUrl, { headers: { 'User-Agent': 'TestMind-Operator/1.0' } });
    rawHtml = await res.text();
  } catch { rawHtml = ''; }

  const hrefRe = /href="([^"#?]+)"/gi;
  const links: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = hrefRe.exec(rawHtml)) !== null && links.length < maxPages * 2) {
    const href = m[1].trim();
    if (!href || href.startsWith('mailto:') || href.startsWith('tel:')) continue;
    try {
      const abs = new URL(href, baseUrl).href;
      if (abs.startsWith(baseUrl) && !visited.has(abs)) { visited.add(abs); links.push(abs); }
    } catch {
      const clean = '/' + href.replace(/^\/+/, '');
      if (!visited.has(clean)) { visited.add(clean); links.push(baseUrl + clean); }
    }
  }

  const checkedRoutes: Array<{ route: string; status: number; reachable: boolean }> = [
    { route: '/', status: 200, reachable: homeResult.success },
  ];

  for (const link of links.slice(0, maxPages - 1)) {
    const checkResult = await runBrowserCapability({ action: 'check', target: link }, ctx2);
    const routePath = (() => { try { return new URL(link).pathname; } catch { return link; } })();
    checkedRoutes.push({ route: routePath, status: (checkResult.data as any)?.status ?? 0, reachable: checkResult.success });
    discovered.push(routePath);
  }

  const generatedTests = await prisma.testCase.findMany({
    where: { projectId: opJob.projectId },
    select: { title: true },
  });
  const coveredRouteHints = generatedTests.map((t) => t.title.toLowerCase());

  const uncovered = checkedRoutes
    .filter((r) => r.reachable)
    .filter((r) => {
      const rl = r.route.toLowerCase();
      return !coveredRouteHints.some((h) => h.includes(rl) || rl.includes(h));
    })
    .map((r) => r.route);

  const outputJson = {
    baseUrl,
    discoveredRoutes: checkedRoutes,
    uncoveredRoutes: uncovered,
    existingTestCount: generatedTests.length,
    summary: `Discovered ${checkedRoutes.length} routes; ${uncovered.length} have no test coverage`,
  };

  await prisma.operatorTask.update({
    where: { id: discoverTask.id },
    data: { status: 'succeeded', finishedAt: new Date(), outputJson },
  });

  // Record discovery report as artifact
  await recordArtifact({
    jobId: opJob.id,
    taskId: discoverTask.id,
    type: 'report',
    path: `jobs/${opJob.id}/discovery-routes.json`,
    meta: { routeCount: checkedRoutes.length, uncoveredCount: uncovered.length },
  });

  console.log(`[operator-worker] discovery: ${checkedRoutes.length} routes found, ${uncovered.length} uncovered`);
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
    ctx.baseUrl || (!isLikelyGitRepo(repoUrl) && /^https?:\/\//i.test(repoUrl) ? repoUrl : '');

  if (!baseUrl) throw new Error('Security job requires a baseUrl or a non-git project.repoUrl');

  const securityCtx: SecurityResumeCtx = {
    baseUrl,
    allowedHosts: ctx.allowedHosts ?? [new URL(baseUrl).hostname],
    allowedPorts: ctx.allowedPorts ?? [80, 443],
    maxDurationMinutes: Number(ctx.maxDurationMinutes ?? 10),
    enableActive: Boolean(ctx.enableActive ?? false),
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

  if (securityCtx.enableActive && opJob.requestedBy) {
    const approval = await prisma.operatorApproval.create({
      data: {
        jobId: opJob.id,
        taskId: task.id,
        actionType: 'security_active_test',
        requestedBy: opJob.requestedBy,
        contextJson: {
          prompt: `Run active DAST probes (XSS, SQLi, path traversal, open redirect) against ${baseUrl}`,
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
