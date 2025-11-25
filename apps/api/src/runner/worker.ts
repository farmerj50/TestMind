import { Worker, Job } from 'bullmq';
import path from 'path';
import fs from 'fs/promises';
import { prisma } from '../prisma';
import { redis } from './redis';
import { makeWorkdir, rmrf } from './workdir';
import { cloneRepo } from './git';
import { detectFramework, installDeps, runTests } from './node-test-exec';
import { parseResults } from './result-parsers';
import { scheduleSelfHealingForRun } from './self-heal';
import type { RunPayload } from './queue';

type RunStatus = "queued" | "running" | "succeeded" | "failed";
type ResultStatus = "passed" | "failed" | "skipped" | "error";
const TestRunStatus: Record<RunStatus, RunStatus> = {
  queued: "queued",
  running: "running",
  succeeded: "succeeded",
  failed: "failed",
};
const TestResultStatus: Record<ResultStatus, ResultStatus> = {
  passed: "passed",
  failed: "failed",
  skipped: "skipped",
  error: "error",
};

function mapStatus(s: string): ResultStatus {
  if (s === 'passed') return TestResultStatus.passed;
  if (s === 'failed' || s === 'error') return TestResultStatus.failed;
  if (s === 'skipped') return TestResultStatus.skipped;
  return TestResultStatus.error;
}

const stripAnsi = (value?: string | null) =>
  typeof value === 'string' ? value.replace(/\u001b\[[0-9;]*m/g, '') : value ?? null;

export const worker = new Worker(
  'test-runs',
  async (job: Job) => {
    const { runId, payload } = job.data as { runId: string; payload?: RunPayload };

    const run = await prisma.testRun.findUnique({
      where: { id: runId },
      include: {
        project: { select: { id: true, ownerId: true, repoUrl: true } },
      },
    });
    if (!run || !run.project?.repoUrl) {
      throw new Error('Run or project/repoUrl not found');
    }

    const project = run.project;

    const outDir = path.join(process.cwd(), 'runner-logs', runId);
    await fs.mkdir(outDir, { recursive: true });

    const work = await makeWorkdir();
    try {
      // GitHub token if connected
      const gitAcct = await prisma.gitAccount.findFirst({
        where: { userId: project.ownerId, provider: 'github' },
        select: { token: true },
      });

      // 1) Clone
      await cloneRepo(project.repoUrl, work, gitAcct?.token || undefined);

      // 2) Install deps
      await installDeps(work);

      // 3) Detect + run
      const framework = await detectFramework(work);
      const resultsPath = path.join(outDir, 'report.json');
      const exec = await runTests({
        workdir: work,
        jsonOutPath: resultsPath,
        headed: payload?.headed,
      });

      // write logs
      await fs.writeFile(path.join(outDir, 'stdout.txt'), exec.stdout ?? '');
      await fs.writeFile(path.join(outDir, 'stderr.txt'), exec.stderr ?? '');

      // 4) Parse → DB
      let parsedCount = 0;
      let failed = 0;
      let passed = 0;
      let skipped = 0;

      if (exec.resultsPath) {
        const cases = await parseResults(exec.resultsPath);

        await prisma.$transaction(async (db) => {
          for (const c of cases) {
            const key = `${c.file}#${c.fullName}`.slice(0, 255);

            const testCase = await db.testCase.upsert({
              where: { projectId_key: { projectId: project.id, key } },
              update: { title: c.fullName },
              create: { projectId: project.id, key, title: c.fullName },
            });

            await db.testResult.create({
              data: {
                run: { connect: { id: runId } },
                testCase: { connect: { id: testCase.id } },
                status: mapStatus(c.status),
                durationMs: c.durationMs ?? null,
                message: c.message ?? null,
              },
            });

            parsedCount++;
            if (c.status === 'passed') passed++;
            else if (c.status === 'failed' || c.status === 'error') failed++;
            else skipped++;
          }
        });
      }

      const ok = failed === 0 && exec.ok;
      await prisma.testRun.update({
        where: { id: runId },
        data: {
          status: ok ? TestRunStatus.succeeded : TestRunStatus.failed,
          finishedAt: new Date(),
          summary: JSON.stringify({ framework, parsedCount, passed, failed, skipped }),
          error: ok ? null : (stripAnsi(exec.stderr) || 'Test command failed'),
        },
      });

      if (!ok && failed > 0) {
        scheduleSelfHealingForRun(runId).catch((err) => {
          console.error(`[worker] failed to schedule self-heal for run ${runId}`, err);
        });
      }
    } catch (err: any) {
      await prisma.testRun.update({
        where: { id: runId },
        data: {
          status: TestRunStatus.failed,
          finishedAt: new Date(),
          error: stripAnsi(err?.message ?? String(err)),
        },
      });
      throw err;
    } finally {
      await rmrf(work).catch(() => {});
    }
  },
  { connection: redis }
);

worker.on('failed', (job, err) => {
  const runId = job?.data?.runId;
  console.error(`[worker] job ${job?.id} (run ${runId ?? 'unknown'}) failed:`, err);
});

worker.on('completed', (job) => {
  const runId = job?.data?.runId;
  console.log(`[worker] job ${job?.id} (run ${runId ?? 'unknown'}) completed`);
});
