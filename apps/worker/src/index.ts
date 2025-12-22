// apps/worker/src/index.ts
import { Worker, QueueEvents } from 'bullmq';
import { execa } from 'execa';
import path from 'node:path';
import fs from 'node:fs/promises';
import { prisma } from './prisma.js';
import 'dotenv/config';
const toPosix = (p: string) => p.replace(/\\/g, "/");
const cleanPath = (p: string) => toPosix(p.replace(/^"(.*)"$/, "$1").trim());

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const QUEUE_NAME = process.env.TM_QUEUE || 'test-runs';
const GENERATED_ROOT = process.env.TM_GENERATED_ROOT
  ? path.resolve(process.env.TM_GENERATED_ROOT)
  : path.resolve(process.cwd(), 'testmind-generated');
console.log(`[worker] boot: queues=${QUEUE_NAME},agent-sessions redis=${REDIS_URL}`);
const qe = new QueueEvents(QUEUE_NAME, { connection: { url: REDIS_URL } });
qe.on('failed', ({ jobId, failedReason }) => console.error('[worker] failed', jobId, failedReason));
qe.on('completed', ({ jobId }) => console.log('[worker] completed', jobId));

const agentQE = new QueueEvents('agent-sessions', { connection: { url: REDIS_URL } });
agentQE.on('failed', ({ jobId, failedReason }) => console.error('[agent-worker] failed', jobId, failedReason));
agentQE.on('completed', ({ jobId }) => console.log('[agent-worker] completed', jobId));

const connection = { url: REDIS_URL };

const testRunWorker = new Worker(QUEUE_NAME, async job => {
  console.log('[worker] picked job', job.id, 'dataKeys=', Object.keys(job.data));
  const { runId, projectRoot, baseUrl } = job.data as {
    runId: string; projectRoot: string; baseUrl?: string;
  };

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
    // Ensure browsers are installed (non-fatal)
    try {
      await execa('npx', ['playwright', 'install', '--with-deps'], {
        cwd: projectRoot, stdio: 'inherit'
      });
    } catch {}

    const args = [
      "playwright","test",
      "--reporter",`dot,html,json=${jsonReport}`,
      "--output", cleanPath(resultsDir),
      "--config","tm-ci.playwright.config.ts",
      // optional while stabilizing
      //'--workers=2',
    ];

    console.log('[runner] pid=%s cwd=%s', process.pid, projectRoot);
    console.log('[runner] args=%j', args);

    // IMPORTANT: reject:false so exitCode 1 doesn’t throw
    const proc = await execa('npx', args, {
      cwd: projectRoot,
      env: {
        ...process.env,
        BASE_URL: baseUrl || 'http://localhost:5173',
        PLAYWRIGHT_HTML_REPORT: cleanPath(htmlReport),
      },
      stdio: 'inherit',
      reject: false,
    });

    // Try to read summary from JSON
    let passed = 0, failed = 0, total = 0;
    try {
      const raw = await fs.readFile(jsonReport, 'utf8');
      const report = JSON.parse(raw);
      // Playwright json has .suites -> collect stats
      const walk = (node:any) => {
        if (node?.tests) {
          for (const t of node.tests) {
            total++;
            if (t.results?.some((r:any)=>r.status==='passed')) passed++;
            else failed++;
          }
        }
        if (node?.suites) node.suites.forEach(walk);
      };
      walk(report);
    } catch {}

    const succeeded = (proc.exitCode ?? 1) === 0;

    await prisma.testRun.update({
      where: { id: runId },
      data: {
        status: succeeded ? 'succeeded' : 'failed',
        finishedAt: new Date(),
        summary: JSON.stringify({ exitCode: proc.exitCode, total, passed, failed }),
        reportPath: path.join(htmlReport, 'index.html'),
        error: succeeded ? null : `tests failed: ${failed}/${total}`,
      },
    });
  } catch (err:any) {
    await prisma.testRun.update({
      where: { id: runId },
      data: {
        status: 'failed',
        finishedAt: new Date(),
        error: String(err?.shortMessage || err?.message || err),
      },
    });
  }
}, { connection });

testRunWorker.on('ready', () => console.log('[worker] ready on queue', QUEUE_NAME));
testRunWorker.on('error', (e) => console.error('[worker] connection error', e));

const agentWorker = new Worker('agent-sessions', async job => {
  console.log('[agent-worker] picked job', job.id, 'dataKeys=', Object.keys(job.data));
  const { sessionId } = job.data as { sessionId: string };
  try {
    // mark running
    await prisma.agentSession.update({
      where: { id: sessionId },
      data: { status: 'running', updatedAt: new Date() },
    }).catch(() => {});

    const session = await prisma.agentSession.findUnique({
      where: { id: sessionId },
      include: { pages: { include: { scenarios: true } } },
    });
    if (!session) {
      return;
    }
    // Ensure a page exists
    let page = session.pages[0];
    if (!page) {
      page = await prisma.agentPage.create({
        include: { scenarios: true },
        data: {
          sessionId: session.id,
          path: '/',
          url: session.baseUrl,
          status: 'pending',
          coverage: {},
        },
      });
    }

    // Seed a couple of safe, low‑brittleness scenarios if none exist
    if (!page.scenarios.length) {
      const baseSteps = [
        { kind: 'goto', url: session.baseUrl },
        { kind: 'expect-visible', selector: 'body' },
      ];
      const scenarios = [
        {
          title: 'Auto navigation',
          coverageType: 'navigation',
          steps: baseSteps,
        },
        {
          title: 'Basic page health',
          coverageType: 'smoke',
          steps: [
            { kind: 'goto', url: session.baseUrl },
            { kind: 'expect-visible', selector: 'body' },
            { kind: 'expect-visible', selector: 'main,body' },
          ],
        },
      ];
      await prisma.agentScenario.createMany({
        data: scenarios.map((s) => ({
          pageId: page.id,
          title: s.title,
          coverageType: s.coverageType,
          status: 'suggested',
          steps: s.steps as any,
        })),
      });
    }

    await prisma.agentPage.update({
      where: { id: page.id },
      data: {
        status: 'completed',
        summary: 'Auto-generated by worker',
        coverage: { auto: 1, smoke: 1 } as any,
        error: null,
      },
    });

    await prisma.agentSession.update({
      where: { id: session.id },
      data: { status: 'ready' },
    });
  } catch (err: any) {
    console.error('[agent-worker] error', err);
    // try to capture the last page if possible
    try {
      const page = await prisma.agentPage.findFirst({ where: { sessionId }, orderBy: { createdAt: 'desc' } });
      if (page) {
        await prisma.agentPage.update({
          where: { id: page.id },
          data: { status: 'failed', error: err?.message || String(err) },
        });
      }
    } catch {}
    await prisma.agentSession.update({
      where: { id: job.data.sessionId },
      data: { status: 'failed' },
    }).catch(() => {});
  }
}, { connection });

agentWorker.on('ready', () => console.log('[agent-worker] ready on queue agent-sessions'));
agentWorker.on('error', (e) => console.error('[agent-worker] connection error', e));
