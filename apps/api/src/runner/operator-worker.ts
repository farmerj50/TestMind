import { Worker, Job } from 'bullmq';
import { prisma } from '../prisma.js';
import { redis } from './redis.js';
import { enqueueRun, enqueueSelfHeal, enqueueSecurityScan } from './queue.js';
import type { OperatorJobPayload } from './queue.js';
import { createStepRunner } from './step-executor.js';
import { runBrowserCapability } from './capabilities/browser-cap.js';

export { createStepRunner };

/**
 * Operator worker — orchestrates OperatorJob lifecycle.
 *
 * Sprint 1: qa   — creates OperatorTask, enqueues TestRun, polls for completion.
 * Sprint 3: capability runtime wired in via createStepRunner / step-executor.ts.
 * Sprint 4: repair  — finds failing tests in the most-recent run, enqueues self-heal per test.
 *           discovery — browses the app, extracts routes, reports coverage gaps.
 */
export const operatorWorker = new Worker(
  'operator-jobs',
  async (job: Job) => {
    const { operatorJobId } = job.data as OperatorJobPayload;

    const opJob = await prisma.operatorJob.findUnique({
      where: { id: operatorJobId },
      select: {
        id: true,
        projectId: true,
        type: true,
        status: true,
        contextJson: true,
        requestedBy: true,
      },
    });

    if (!opJob) throw new Error(`OperatorJob ${operatorJobId} not found`);
    if (opJob.status === 'canceled') return;

    await prisma.operatorJob.update({
      where: { id: operatorJobId },
      data: { status: 'running', startedAt: new Date() },
    });

    try {
      if (opJob.type === 'qa') {
        await runQaJob(opJob);
      } else if (opJob.type === 'repair') {
        await runRepairJob(opJob);
      } else if (opJob.type === 'discovery') {
        await runDiscoveryJob(opJob);
      } else if (opJob.type === 'security') {
        await runSecurityJob(opJob);
      } else {
        throw new Error(`OperatorJob type '${opJob.type}' not yet implemented`);
      }

      await prisma.operatorJob.update({
        where: { id: operatorJobId },
        data: { status: 'succeeded', finishedAt: new Date() },
      });
    } catch (err: any) {
      await prisma.operatorJob.update({
        where: { id: operatorJobId },
        data: {
          status: 'failed',
          finishedAt: new Date(),
          error: err?.message ?? String(err),
        },
      });
      throw err;
    }
  },
  { connection: redis }
);

const isLikelyGitRepo = (url?: string | null) => {
  if (!url) return false;
  const t = url.trim();
  return t.endsWith('.git') || t.startsWith('git@') || /github\.com|gitlab\.com|bitbucket\.org/.test(t);
};

async function runQaJob(opJob: {
  id: string;
  projectId: string;
  contextJson: unknown;
}) {
  const ctx = (opJob.contextJson ?? {}) as Record<string, any>;

  // Infer mode the same way worker.ts does — if no valid git repo URL, use ai mode
  const project = await prisma.project.findUnique({
    where: { id: opJob.projectId },
    select: { repoUrl: true },
  });
  const explicitMode = ctx.mode as string | undefined;
  const inferredMode = explicitMode ?? (isLikelyGitRepo(project?.repoUrl) ? 'regular' : 'ai');

  // Use the project's repoUrl as the base URL when it's an app URL (not a git repo)
  // and no explicit baseUrl was passed in the job context.
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

  await prisma.operatorTask.update({
    where: { id: task.id },
    data: { testRunId: run.id },
  });

  await enqueueRun(run.id, {
    projectId: opJob.projectId,
    baseUrl: inferredBaseUrl,
    mode: inferredMode as 'regular' | 'ai',
    file: ctx.file,
    grep: ctx.grep,
  });

  await waitForRun(run.id, task.id);
}

// ── repair job ───────────────────────────────────────────────────────────────

/**
 * Repair job — finds failing tests in the most-recent (or specified) test run,
 * enqueues a self-heal attempt per failing test, and tracks progress via OperatorTask.
 *
 * contextJson options:
 *   runId?    — specific TestRun to repair (defaults to most-recent failed run)
 *   baseUrl?  — override base URL for verification reruns
 *   maxTests? — cap how many tests to repair (default 10)
 */
async function runRepairJob(opJob: {
  id: string;
  projectId: string;
  contextJson: unknown;
  requestedBy: string | null;
}) {
  const ctx = (opJob.contextJson ?? {}) as Record<string, any>;
  const maxTests = Number(ctx.maxTests ?? 10);

  // Resolve baseUrl the same way as the QA job
  const project = await prisma.project.findUnique({
    where: { id: opJob.projectId },
    select: { repoUrl: true },
  });
  const repoUrl = project?.repoUrl?.trim() ?? '';
  const baseUrl: string | undefined =
    ctx.baseUrl ||
    (!isLikelyGitRepo(repoUrl) && /^https?:\/\//i.test(repoUrl) ? repoUrl : undefined);

  // Find the run to repair
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

  // Triage task — identifies which tests need repair
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
    where: { runId: targetRunId, status: 'failed' },
    include: { testCase: { select: { id: true, title: true } } },
    take: maxTests,
    orderBy: { createdAt: 'asc' },
  });

  const totalFailed = failingResults.length;

  await prisma.operatorTask.update({
    where: { id: triageTask.id },
    data: {
      status: 'succeeded',
      finishedAt: new Date(),
      outputJson: { runId: targetRunId, failingCount: totalFailed },
    },
  });

  if (totalFailed === 0) {
    console.log(`[operator-worker] repair: run ${targetRunId} has no failing tests`);
    return;
  }

  // One repair OperatorTask per failing test
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

  // Enqueue self-heal for each failing test
  const healAttemptBase = `operator:${opJob.id}`;
  await Promise.all(
    failingResults.map((r, i) =>
      enqueueSelfHeal({
        runId: targetRunId!,
        testResultId: r.id,
        testCaseId: r.testCase?.id ?? r.id,
        attemptId: `${healAttemptBase}:${r.id}`,
        projectId: opJob.projectId,
        totalFailed,
        testTitle: r.testCase?.title ?? undefined,
        baseUrl,
      }).then(() => {
        console.log(
          `[operator-worker] repair: enqueued self-heal for test "${r.testCase?.title}" (task ${repairTasks[i].id})`
        );
      })
    )
  );

  // Poll all repair tasks — mark them succeeded when the heal job finishes
  // We use the self-heal pipeline's output: check if TestResult status flipped.
  const pollInterval = 5000;
  const deadline = Date.now() + 20 * 60 * 1000; // 20 min total

  const remaining = new Set(failingResults.map((r) => r.id));
  const taskByResultId = new Map(failingResults.map((r, i) => [r.id, repairTasks[i]]));

  while (remaining.size > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollInterval));

    const updated = await prisma.testResult.findMany({
      where: { id: { in: [...remaining] } },
      select: { id: true, status: true, message: true },
    });

    for (const res of updated) {
      if (res.status === 'passed' || res.status === 'failed') {
        const task = taskByResultId.get(res.id);
        if (task) {
          await prisma.operatorTask.update({
            where: { id: task.id },
            data: {
              status: res.status === 'passed' ? 'succeeded' : 'failed',
              finishedAt: new Date(),
              error: res.status === 'failed' ? (res.message ?? 'Self-heal did not fix the test') : null,
              outputJson: { testResultId: res.id, finalStatus: res.status },
            },
          });
        }
        remaining.delete(res.id);
      }
    }
  }

  // Mark any still-pending tasks as failed (timeout)
  await Promise.all(
    [...remaining].map((resultId) => {
      const task = taskByResultId.get(resultId);
      if (!task) return;
      return prisma.operatorTask.update({
        where: { id: task.id },
        data: { status: 'failed', finishedAt: new Date(), error: 'Self-heal did not complete in time' },
      });
    })
  );
}

// ── discovery job ─────────────────────────────────────────────────────────────

/**
 * Discovery job — browses the app to find routes and pages, then reports
 * which routes have no existing generated test coverage.
 *
 * contextJson options:
 *   baseUrl?   — app URL to crawl (defaults to project.repoUrl)
 *   maxPages?  — max links to follow from the home page (default 20)
 */
async function runDiscoveryJob(opJob: {
  id: string;
  projectId: string;
  contextJson: unknown;
}) {
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

  if (!baseUrl) {
    throw new Error('Discovery job requires a baseUrl in contextJson or a non-git project.repoUrl');
  }

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

  // Step 1: navigate home page
  const homeResult = await runBrowserCapability({ action: 'navigate', target: baseUrl }, ctx2);
  if (!homeResult.success) {
    throw new Error(`Discovery: cannot reach ${baseUrl}: ${homeResult.error}`);
  }

  // Step 2: crawl links from home page HTML
  const visited = new Set<string>([baseUrl]);
  const discovered: string[] = ['/'];

  // Re-fetch raw HTML to extract links
  let rawHtml = '';
  try {
    const res = await fetch(baseUrl, { headers: { 'User-Agent': 'TestMind-Operator/1.0' } });
    rawHtml = await res.text();
  } catch {
    rawHtml = '';
  }

  const hrefRe = /href="([^"#?]+)"/gi;
  const links: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = hrefRe.exec(rawHtml)) !== null && links.length < maxPages * 2) {
    const href = m[1].trim();
    if (!href || href.startsWith('mailto:') || href.startsWith('tel:')) continue;
    try {
      const abs = new URL(href, baseUrl).href;
      if (abs.startsWith(baseUrl) && !visited.has(abs)) {
        visited.add(abs);
        links.push(abs);
      }
    } catch {
      // relative path that URL failed to parse — use as-is
      const clean = '/' + href.replace(/^\/+/, '');
      if (!visited.has(clean)) {
        visited.add(clean);
        links.push(baseUrl + clean);
      }
    }
  }

  // Step 3: health-check each discovered link (up to maxPages)
  const checkedRoutes: Array<{ route: string; status: number; reachable: boolean }> = [
    { route: '/', status: 200, reachable: homeResult.success },
  ];

  for (const link of links.slice(0, maxPages - 1)) {
    const checkResult = await runBrowserCapability({ action: 'check', target: link }, ctx2);
    const routePath = (() => {
      try { return new URL(link).pathname; } catch { return link; }
    })();
    const statusVal = (checkResult.data as any)?.status ?? 0;
    checkedRoutes.push({ route: routePath, status: statusVal, reachable: checkResult.success });
    discovered.push(routePath);
  }

  // Step 4: compare against existing generated test files
  const generatedTests = await prisma.testCase.findMany({
    where: { projectId: opJob.projectId },
    select: { title: true },
  });
  const coveredRouteHints = generatedTests.map((t) => t.title.toLowerCase());

  const uncovered = checkedRoutes
    .filter((r) => r.reachable)
    .filter((r) => {
      const routeLower = r.route.toLowerCase();
      return !coveredRouteHints.some((hint) => hint.includes(routeLower) || routeLower.includes(hint));
    })
    .map((r) => r.route);

  await prisma.operatorTask.update({
    where: { id: discoverTask.id },
    data: {
      status: 'succeeded',
      finishedAt: new Date(),
      outputJson: {
        baseUrl,
        discoveredRoutes: checkedRoutes,
        uncoveredRoutes: uncovered,
        existingTestCount: generatedTests.length,
        summary: `Discovered ${checkedRoutes.length} routes; ${uncovered.length} have no test coverage`,
      },
    },
  });

  console.log(
    `[operator-worker] discovery: ${checkedRoutes.length} routes found, ${uncovered.length} uncovered`
  );
}

// ── security job ─────────────────────────────────────────────────────────────

/**
 * Security job — creates a SecurityScanJob, enqueues it, and polls for completion.
 * Active scanning (DAST probes that mutate state) requires user approval first.
 *
 * contextJson options:
 *   baseUrl?             — override base URL (defaults to project.repoUrl)
 *   allowedHosts?        — array of hosts in scope (default: derived from baseUrl)
 *   allowedPorts?        — array of ports in scope (default: [80, 443])
 *   maxDurationMinutes?  — max scan time (default 10)
 *   enableActive?        — run active DAST probes (default false; requires approval)
 */
async function runSecurityJob(opJob: {
  id: string;
  projectId: string;
  contextJson: unknown;
  requestedBy: string | null;
}) {
  const ctx = (opJob.contextJson ?? {}) as Record<string, any>;

  const project = await prisma.project.findUnique({
    where: { id: opJob.projectId },
    select: { repoUrl: true },
  });
  const repoUrl = project?.repoUrl?.trim() ?? '';
  const baseUrl: string =
    ctx.baseUrl ||
    (!isLikelyGitRepo(repoUrl) && /^https?:\/\//i.test(repoUrl) ? repoUrl : '');

  if (!baseUrl) {
    throw new Error('Security job requires a baseUrl in contextJson or a non-git project.repoUrl');
  }

  const allowedHosts: string[] = ctx.allowedHosts ?? [new URL(baseUrl).hostname];
  const allowedPorts: number[] = ctx.allowedPorts ?? [80, 443];
  const maxDurationMinutes: number = Number(ctx.maxDurationMinutes ?? 10);
  const enableActive: boolean = Boolean(ctx.enableActive ?? false);

  // Create a tracking OperatorTask
  const task = await prisma.operatorTask.create({
    data: {
      jobId: opJob.id,
      type: 'execute',
      status: 'running',
      startedAt: new Date(),
      inputJson: { baseUrl, enableActive, allowedHosts, allowedPorts },
    },
  });

  // Active probes mutate state — require approval before proceeding
  if (enableActive && opJob.requestedBy) {
    await requestApproval({
      jobId: opJob.id,
      taskId: task.id,
      requestedBy: opJob.requestedBy,
      actionType: 'security_active_test',
      description: `Run active DAST probes (XSS, SQLi, path traversal, open redirect) against ${baseUrl}`,
      context: { baseUrl, allowedHosts },
    });
  }

  // Create and enqueue the SecurityScanJob
  const scan = await prisma.securityScanJob.create({
    data: {
      projectId: opJob.projectId,
      status: 'queued',
      config: { baseUrl, allowedHosts, allowedPorts, maxDurationMinutes, enableActive } as any,
    },
  });

  await enqueueSecurityScan({
    jobId: scan.id,
    projectId: opJob.projectId,
    baseUrl,
    allowedHosts,
    allowedPorts,
    maxDurationMinutes,
    enableActive,
  });

  // Poll until scan completes
  const deadline = Date.now() + maxDurationMinutes * 60 * 1000 + 60_000;
  const interval = 5000;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, interval));
    const current = await prisma.securityScanJob.findUnique({
      where: { id: scan.id },
      select: { status: true, summary: true, error: true, findings: { select: { severity: true } } },
    });
    if (!current) break;

    if (current.status === 'completed' || current.status === 'failed') {
      const counts = current.findings.reduce<Record<string, number>>((acc, f) => {
        acc[f.severity] = (acc[f.severity] || 0) + 1;
        return acc;
      }, {});
      await prisma.operatorTask.update({
        where: { id: task.id },
        data: {
          status: current.status === 'completed' ? 'succeeded' : 'failed',
          finishedAt: new Date(),
          error: current.error ?? null,
          outputJson: { scanId: scan.id, findingCounts: counts, summary: current.summary },
        },
      });
      if (current.status === 'failed') {
        throw new Error(`Security scan failed: ${current.error}`);
      }
      return;
    }
  }

  // Timeout — mark task failed but don't throw (partial results may still be useful)
  await prisma.operatorTask.update({
    where: { id: task.id },
    data: {
      status: 'failed',
      finishedAt: new Date(),
      error: `Security scan timed out after ${maxDurationMinutes} minutes`,
      outputJson: { scanId: scan.id },
    },
  });
  throw new Error(`Security scan timed out (scanId=${scan.id})`);
}

/**
 * Creates a pending OperatorApproval, sets the job status to 'blocked',
 * and polls until the approval is resolved or times out.
 * Returns 'approved' or throws if denied/timed-out.
 *
 * @param actionType - The schema-defined action type (run_terminal, git_push, patch_code, security_active_test)
 * @param description - Human-readable description shown to the approver (stored in contextJson.prompt)
 */
async function requestApproval(opts: {
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

  await prisma.operatorJob.update({
    where: { id: jobId },
    data: { status: 'blocked' },
  });
  // OperatorTask has no 'blocked' status — leave it as 'running' while waiting

  const interval = 4000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const current = await prisma.operatorApproval.findUnique({
      where: { id: approval.id },
      select: { status: true },
    });
    if (current?.status === 'approved') {
      // Unblock job so execution continues
      await prisma.operatorJob.update({ where: { id: jobId }, data: { status: 'running' } });
      return 'approved';
    }
    if (current?.status === 'denied') {
      throw new Error(`Approval denied for job ${jobId}: "${description}"`);
    }
    await new Promise((r) => setTimeout(r, interval));
  }

  await prisma.operatorApproval.update({
    where: { id: approval.id },
    data: { status: 'expired' },
  });
  throw new Error(`Approval timed out for job ${jobId}: "${description}"`);
}

export { requestApproval };

async function waitForRun(runId: string, taskId: string, timeoutMs = 10 * 60 * 1000) {
  const interval = 3000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const run = await prisma.testRun.findUnique({
      where: { id: runId },
      select: { status: true, error: true },
    });

    if (!run) break;

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
      return;
    }

    await new Promise((r) => setTimeout(r, interval));
  }

  await prisma.operatorTask.update({
    where: { id: taskId },
    data: {
      status: 'failed',
      finishedAt: new Date(),
      error: `Timed out waiting for TestRun ${runId}`,
    },
  });
  throw new Error(`waitForRun timeout for run ${runId}`);
}

operatorWorker.on('failed', (job, err) => {
  console.error(`[operator-worker] job ${job?.id} failed:`, err);
});

operatorWorker.on('completed', (job) => {
  console.log(`[operator-worker] job ${job?.id} completed`);
});
