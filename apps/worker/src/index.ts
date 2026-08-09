// apps/worker/src/index.ts
import { Worker, QueueEvents } from 'bullmq';
import { execa } from 'execa';
import path from 'node:path';
import fs from 'node:fs/promises';
import { prisma } from './prisma.js';
import 'dotenv/config';
import { crawlFingerprint, injectSpecHeader, type CrawlMetadata } from '@testmind/generator';
const toPosix = (p: string) => p.replace(/\\/g, "/");
const cleanPath = (p: string) => toPosix(p.replace(/^"(.*)"$/, "$1").trim());

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const QUEUE_NAME = process.env.TM_QUEUE || 'test-runs';
const GENERATED_ROOT = process.env.TM_GENERATED_ROOT
  ? path.resolve(process.env.TM_GENERATED_ROOT)
  : path.resolve(process.cwd(), 'testmind-generated');
const REPORT_ROOT = process.env.TM_REPORT_ROOT
  ? path.resolve(process.env.TM_REPORT_ROOT)
  : path.resolve(process.cwd(), 'testmind-reports');
const RUNNER_LOGS_BASE = process.env.TM_RUNNER_LOGS_BASE
  ? path.resolve(process.env.TM_RUNNER_LOGS_BASE)
  : path.join(REPORT_ROOT, 'runner-logs');
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
  const artifactsDir = path.join(RUNNER_LOGS_BASE, runId);

  await fs.mkdir(htmlReport, { recursive: true });
  await fs.mkdir(resultsDir, { recursive: true });
  await fs.mkdir(artifactsDir, { recursive: true });

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
        TM_RUN_ID: runId,
        TM_SPEC_PATH: outDir,
        TM_RUN_ARTIFACTS_DIR: cleanPath(artifactsDir),
        TM_HEAL_MODE: process.env.TM_HEAL_MODE || '0',
        TM_ATTEMPT: process.env.TM_ATTEMPT || '1',
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

// ── Lightweight HTTP crawler for agent sessions ───────────────────────────────

function extractLinks(html: string, baseUrl: string): string[] {
  const seen = new Set<string>();
  const base = new URL(baseUrl);
  const hrefRe = /href=["']([^"'#?][^"']*?)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = hrefRe.exec(html)) !== null) {
    try {
      const url = new URL(m[1], baseUrl);
      if (url.hostname === base.hostname && url.pathname !== base.pathname) {
        seen.add(url.pathname);
      }
    } catch { /* ignore */ }
  }
  return [...seen].slice(0, 40);
}

function extractForms(html: string): CrawlMetadata["forms"] {
  const forms: CrawlMetadata["forms"] = [];
  const formRe = /<form[^>]*action=["']([^"']*)["'][^>]*method=["']([^"']*)["'][^>]*>([\s\S]*?)<\/form>/gi;
  const inputRe = /name=["']([^"']+)["']/gi;
  let fm: RegExpExecArray | null;
  while ((fm = formRe.exec(html)) !== null) {
    const fields: string[] = [];
    let im: RegExpExecArray | null;
    while ((im = inputRe.exec(fm[3])) !== null) fields.push(im[1]);
    forms.push({ action: fm[1] || '/', method: (fm[2] || 'GET').toUpperCase(), fields });
  }
  return forms;
}

function extractApis(html: string): string[] {
  const apis = new Set<string>();
  const apiRe = /["'](\/api\/[^"'?#\s]+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = apiRe.exec(html)) !== null) apis.add(m[1]);
  return [...apis].slice(0, 20);
}

async function crawlSite(baseUrl: string, maxRoutes: number = 30): Promise<CrawlMetadata> {
  const visited = new Set<string>();
  const queue = ['/'];
  const routes: string[] = [];
  let forms: CrawlMetadata["forms"] = [];
  let apis: string[] = [];

  while (queue.length > 0 && routes.length < maxRoutes) {
    const pathname = queue.shift()!;
    if (visited.has(pathname)) continue;
    visited.add(pathname);

    try {
      const res = await fetch(new URL(pathname, baseUrl).toString(), {
        headers: { 'User-Agent': 'TestMind-Agent/1.0' },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) continue;
      const ct = res.headers.get('content-type') ?? '';
      if (!ct.includes('html')) continue;
      const html = await res.text();
      routes.push(pathname);
      const newLinks = extractLinks(html, baseUrl);
      for (const link of newLinks) {
        if (!visited.has(link)) queue.push(link);
      }
      if (forms.length === 0) forms = extractForms(html);
      if (apis.length === 0) apis = extractApis(html);
    } catch {
      // skip unreachable routes
    }
  }

  const metadata: CrawlMetadata = {
    routes,
    forms,
    apis,
    authRequired: routes.some((r) => /login|signin|auth/i.test(r)),
    crawlDepth: 2,
    pageCount: routes.length,
  };
  metadata.fingerprint = crawlFingerprint(metadata);
  return metadata;
}

// ── Agent worker ──────────────────────────────────────────────────────────────

const agentWorker = new Worker('agent-sessions', async job => {
  console.log('[agent-worker] picked job', job.id, 'dataKeys=', Object.keys(job.data));
  const { sessionId } = job.data as { sessionId: string };
  try {
    await prisma.agentSession.update({
      where: { id: sessionId },
      data: { status: 'running', updatedAt: new Date() },
    }).catch(() => {});

    const session = await prisma.agentSession.findUnique({
      where: { id: sessionId },
      include: { pages: { include: { scenarios: true } } },
    });
    if (!session) return;

    let page = session.pages[0];
    if (!page) {
      page = await prisma.agentPage.create({
        include: { scenarios: true },
        data: { sessionId: session.id, path: '/', url: session.baseUrl, status: 'pending', coverage: {} },
      });
    }

    // Fingerprint check — skip regeneration if site hasn't changed
    const prevFingerprint = (page.coverage as any)?.fingerprint as string | undefined;

    const metadata = await crawlSite(session.baseUrl);
    const newFingerprint = metadata.fingerprint!;

    if (prevFingerprint && prevFingerprint === newFingerprint && page.scenarios.length > 0) {
      console.log(`[agent-worker] crawl fingerprint unchanged (${newFingerprint}) — skipping regeneration`);
      await prisma.agentSession.update({ where: { id: session.id }, data: { status: 'ready' } });
      return;
    }

    // Build scenarios from discovered routes
    const specOutDir = path.join(GENERATED_ROOT, 'agent-sessions', sessionId, 'playwright-ts');
    await fs.mkdir(specOutDir, { recursive: true });

    const scenariosToCreate = metadata.routes.map((route) => {
      const title = `Test ${route === '/' ? 'Home' : route.replace(/^\//, '').replace(/\//g, ' / ')}`;
      const specContent = injectSpecHeader(
        [
          `import { test, expect } from '@playwright/test';`,
          ``,
          `test('${title}', async ({ page }) => {`,
          `  await page.goto('${new URL(route, session.baseUrl).toString()}');`,
          `  await expect(page.locator('body')).toBeVisible();`,
          `});`,
        ].join('\n'),
        { target: session.baseUrl, crawlDepth: metadata.crawlDepth }
      );
      const fileName = `${route.replace(/^\//, '').replace(/\//g, '-') || 'home'}.spec.ts`;
      const specPath = path.join(specOutDir, fileName);
      return { title, specContent, specPath, route };
    });

    // Write spec files and create scenarios
    if (page.scenarios.length > 0) {
      await prisma.agentScenario.deleteMany({ where: { pageId: page.id } });
    }

    await Promise.all(scenariosToCreate.map((s) => fs.writeFile(s.specPath, s.specContent, 'utf8')));

    await prisma.agentScenario.createMany({
      data: scenariosToCreate.map((s) => ({
        pageId: page.id,
        title: s.title,
        coverageType: 'navigation',
        status: 'suggested',
        specPath: s.specPath,
        steps: [
          { kind: 'goto', url: new URL(s.route, session.baseUrl).toString() },
          { kind: 'expect-visible', selector: 'body' },
        ] as any,
      })),
    });

    await prisma.agentPage.update({
      where: { id: page.id },
      data: {
        status: 'completed',
        summary: `Discovered ${metadata.routes.length} routes, generated ${scenariosToCreate.length} scenarios`,
        coverage: metadata as any,
        fingerprint: newFingerprint,
        error: null,
      },
    });

    await prisma.agentSession.update({ where: { id: session.id }, data: { status: 'ready' } });

    console.log(`[agent-worker] session ${sessionId}: ${metadata.routes.length} routes, ${scenariosToCreate.length} specs → ${specOutDir}`);
  } catch (err: any) {
    console.error('[agent-worker] error', err);
    try {
      const pg = await prisma.agentPage.findFirst({ where: { sessionId }, orderBy: { createdAt: 'desc' } });
      if (pg) await prisma.agentPage.update({ where: { id: pg.id }, data: { status: 'failed', error: err?.message || String(err) } });
    } catch {}
    await prisma.agentSession.update({ where: { id: job.data.sessionId }, data: { status: 'failed' } }).catch(() => {});
  }
}, { connection });

agentWorker.on('ready', () => console.log('[agent-worker] ready on queue agent-sessions'));
agentWorker.on('error', (e) => console.error('[agent-worker] connection error', e));
