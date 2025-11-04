import { Worker, QueueEvents } from 'bullmq';
import { execa } from 'execa';
import path from 'node:path';
import fs from 'node:fs/promises';
import { prisma } from './prisma.js';

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const QUEUE_NAME = process.env.TM_QUEUE || 'test-runs';
const GENERATED_ROOT = process.env.TM_GENERATED_ROOT
  ? path.resolve(process.env.TM_GENERATED_ROOT)
  : path.resolve(process.cwd(), 'testmind-generated');

new QueueEvents(QUEUE_NAME, { connection: { url: REDIS_URL } }); // keeps BullMQ from marking jobs stalled

new Worker(
  QUEUE_NAME,
  async job => {
    const { runId, projectRoot, baseUrl } = job.data as {
      runId: string;
      projectRoot: string;
      baseUrl?: string;
    };

    // -> running
    await prisma.testRun.update({
      where: { id: runId },
      data: { status: 'running', startedAt: new Date(), error: null },
    });

    const outDir = path.join(GENERATED_ROOT, runId);
    const htmlReport = path.join(outDir, 'html-report');
    const resultsDir = path.join(outDir, 'test-results');
    const jsonReport = path.join(outDir, 'report.json');

    await fs.mkdir(htmlReport, { recursive: true });
    await fs.mkdir(resultsDir, { recursive: true });

    try {

      try {
        await execa('npx', ['playwright', 'install', '--with-deps'], { cwd: projectRoot, stdio: 'inherit' });
        } catch { /* ignore; test run will surface any real issue */ }
      // run Playwright with HTML report
      await execa(
        'npx',
        [
          'playwright',
          'test',
          // keep line reporter in logs AND emit html
          // '--reporter=dot,html',
          // `--output=${path.join(outDir, 'test-results')}`,
          `--reporter=dot,html,json=${jsonReport}`,
          `--output=${resultsDir}`,
        ],
        {
          cwd: projectRoot,
          env: {
            ...process.env,
            // use by tests if they rely on BASE_URL
            BASE_URL: baseUrl || 'http://localhost:3000',
            PLAYWRIGHT_HTML_REPORT: htmlReport, // picked up by reporter=html
          },
          stdio: 'inherit',
        }
      );

      // -> succeeded + store report path
      await prisma.testRun.update({
        where: { id: runId },
        data: {
          status: 'succeeded',
          finishedAt: new Date(),
          reportPath: path.join(htmlReport, 'index.html'),
        },
      });
    } catch (err: any) {
      await prisma.testRun.update({
        where: { id: runId },
        data: {
          status: 'failed',
          finishedAt: new Date(),
          error: String(err?.shortMessage || err?.message || err),
        },
      });
      // throw err;
       // Do NOT rethrow: we already marked DB status=failed and we want the job "handled"
    }
  },
  { connection: { url: REDIS_URL } }
);
