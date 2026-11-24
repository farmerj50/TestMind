import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import { archive, artifactModules } from './artifact-harness.mjs';
import { loadTs } from './operator-harness.mjs';
const require = createRequire(new URL('../../apps/api/package.json', import.meta.url));
const { tsImport } = createRequire(import.meta.url)('tsx/esm/api');
export async function artifactConfidentiality(root, scratch, onlyMedia = false) {
  const runRoot = path.join(scratch, 'runner-logs', 'artifact-run'); await fs.mkdir(path.join(runRoot, 'allure-report'), { recursive: true });
  const known = 'final-project-secret-58391', runtime = 'final-sensitive-session-92746';
  const matrix = [], add = (format, passed, detail) => matrix.push({ format, status: passed ? 'PASS' : 'FAIL', detail });
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ recordVideo: { dir: path.join(scratch, 'recorded-video') } });
    const page = await context.newPage(); await page.setContent(`<h1>Synthetic confidential data</h1><p>${runtime}</p>`);
    if (!(await page.locator('body').innerText()).includes(runtime)) throw new Error('Visible credential fixture was not rendered');
    await page.screenshot({ path: path.join(runRoot, 'screenshot.png') });
    await page.waitForTimeout(250); const video = page.video(); await context.close(); await video.saveAs(path.join(runRoot, 'video.webm'));
  } finally { await browser.close(); }
  const prisma = { projectSecret: { findMany: async () => [{ value: known }] }, testRun: { findUnique: async ({ where }) => where.id === 'artifact-run' ? { id: where.id, projectId: 'artifact-project', project: { ownerId: 'owner' } } : null }, project: { findFirst: async ({ where }) => where.id === 'artifact-project' && where.ownerId === 'owner' ? { id: where.id } : null } };
  const { service, routes } = artifactModules(prisma, scratch, { decryptSecret: value => value });
  const app = require('fastify')(); await app.register(routes.artifactRoutes, { roots: [path.join(scratch, 'runner-logs')] });
  const sourceRoot = path.join(scratch, 'generated'), projectRoot = path.join(sourceRoot, 'playwright-ts-owner', 'artifact-project'); await fs.mkdir(projectRoot, { recursive: true });
  const sourceExport = await tsImport(pathToFileURL(path.join(root, 'apps/api/src/lib/source-export.ts')).href, import.meta.url);
  const genAdapterDir = (adapterId, userId) => path.join(sourceRoot, `${adapterId}-${userId}`);
  const genAdapterProjectDir = (adapterId, userId, projectId) => projectId ? path.join(genAdapterDir(adapterId, userId), projectId) : genAdapterDir(adapterId, userId);
  const genListSpecFiles = (adapterId, userId, projectId) => {
    let dir = genAdapterProjectDir(adapterId, userId, projectId);
    if (projectId && !fsSync.existsSync(dir)) { const fallback = genAdapterDir(adapterId, userId); if (fsSync.existsSync(fallback)) dir = fallback; }
    if (!fsSync.existsSync(dir)) return [];
    const list = [];
    const walk = (d, rel = '') => { for (const name of fsSync.readdirSync(d)) { const abs = path.join(d, name); const r = path.join(rel, name); const st = fsSync.statSync(abs); if (st.isDirectory()) walk(abs, r); else list.push({ path: r.replace(/\\/g, '/'), size: st.size }); } };
    walk(dir);
    return list;
  };
  const sourceRoutes = loadTs('apps/api/src/testmind/routes.ts', { fs: fsSync, globby: {}, archiver: require('archiver'), '@clerk/fastify': { getAuth: req => ({ userId: req.headers['x-user-id'] }) }, '../prisma.js': { prisma }, '@testmind/core/framework': { DEFAULT_FRAMEWORK_ID: 'playwright-ts', FRAMEWORK_IDS: ['playwright-ts'] }, '@testmind/core/framework-registry': {}, './service.js': {}, './curated-store.js': { CURATED_ROOT: path.join(scratch, 'curated') }, './generated-files.js': { adapterDir: genAdapterDir, adapterProjectDir: genAdapterProjectDir, listGeneratedSpecFiles: genListSpecFiles }, '../lib/storageRoots.js': { GENERATED_ROOT: sourceRoot }, '../lib/source-export.js': sourceExport, '../lib/artifact-service.js': service });
  await app.register(sourceRoutes.default, { prefix: '/tm' });
  const get = (url, user = 'owner') => app.inject({ url, headers: { 'x-user-id': user, referer: 'http://localhost/runner-logs/artifact-run/allure-report/' } });
  let authorization = true;
  try {
    for (const name of ['screenshot.png', 'video.webm']) {
      const url = `/runner-logs/artifact-run/${name}`, result = await get(url);
      authorization &&= (await get(url, 'foreign')).statusCode === 404;
      const original = await fs.readFile(path.join(runRoot, name));
      add(name, result.statusCode === 422, result.statusCode === 200 && result.rawPayload.equals(original) ? 'Download is byte-identical to media showing the synthetic sensitive value' : `HTTP ${result.statusCode}; unsafe media must fail closed`);
    }
    if (!onlyMedia) {
      const fixtures = [
        ['html-report', 'report.html', `<html><body>${runtime}</body></html>`],
        ['allure-report', 'allure-report/index.html', `<html><body>${runtime}</body></html>`],
        ['execution-log', 'stdout.txt', `Authorization: Bearer ${known}\napplication output: ${runtime}`],
        ['error-json', 'error.json', JSON.stringify({ password: known, message: `Failure displaying private account data: ${runtime}` })],
      ];
      for (const [format, file, content] of fixtures) {
        await fs.writeFile(path.join(runRoot, file), content);
        for (const prefix of ['/runner-logs/', '/_static/runner-logs/', '/runner/runner-logs/']) {
          const url = `${prefix}artifact-run/${file}`, result = await get(url);
          authorization &&= (await get(url, 'foreign')).statusCode === 404;
          add(`${format} (${prefix})`, result.statusCode === 422 || (result.statusCode === 200 && ![known, runtime].some(value => result.rawPayload.includes(Buffer.from(value)))), `HTTP ${result.statusCode}; runtime canary inspection`);
        }
      }
      const asset = await get('/assets/index.html'); add('allure assets alias', asset.statusCode === 422 || (asset.statusCode === 200 && !asset.body.includes(runtime)), `HTTP ${asset.statusCode}`); authorization &&= (await get('/assets/index.html', 'foreign')).statusCode === 404;
      await fs.writeFile(path.join(projectRoot, 'fixture.spec.ts'), `// Synthetic auth fixture\nconst password = ${JSON.stringify(known)};\n`);
      for (const endpoint of ['/tm/generated/file?projectId=artifact-project&file=fixture.spec.ts', '/tm/generated/download?projectId=artifact-project', '/tm/download?projectId=artifact-project']) {
        const result = await get(endpoint); authorization &&= (await get(endpoint, 'foreign')).statusCode === 404;
        const contents = endpoint.includes('/file?') ? [result.rawPayload] : result.statusCode === 200 ? archive.readTraceArchive(result.rawPayload).map(m => m.data) : [];
        add(endpoint.split('?')[0], result.statusCode === 422 || (result.statusCode === 200 && !contents.some(bytes => bytes.includes(Buffer.from(known)))), `HTTP ${result.statusCode}; known project-secret inspection of each download member`);
      }
      await fs.writeFile(path.join(runRoot, 'opaque.bin'), Buffer.from(runtime));
      add('unsupported format', (await get('/runner-logs/artifact-run/opaque.bin')).statusCode === 422, 'Unsupported opaque content rejected');
      add('unscoped raw Playwright report', (await get('/_static/playwright-report/data/trace.zip')).statusCode === 422, 'Unscoped raw artifact route blocked');
      add('private original reference', (await get('/runner-logs/artifact-run/.private-artifacts/originals/trace.zip')).statusCode === 422, 'Private path blocked');
      try {
        execFileSync(process.execPath, ['tests/workflows/trace-live.mjs'], { cwd: root, windowsHide: true, timeout: 60000, stdio: 'pipe' });
        add('real trace and Trace Viewer', true, 'Existing live eleven-category recorder/download/viewer fixture passed');
      } catch { add('real trace and Trace Viewer', false, 'Existing live trace fixture failed'); }
    }
    add('project ownership', authorization, 'Foreign owner denied on every exercised download route');
    return matrix;
  } finally { await app.close(); }
}
if (process.argv.includes('--media-only')) {
  const root = process.cwd(), scratch = path.join(root, 'tests/workflows/.scratch/final');
  const results = await artifactConfidentiality(root, scratch, true);
  await fs.writeFile(path.join(scratch, 'media-retest.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results)); if (results.some(r => r.status !== 'PASS')) process.exitCode = 2;
}
