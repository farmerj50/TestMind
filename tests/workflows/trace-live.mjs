// Synthetic credentials and loopback target only. Exercises the actual recorder,
// download service and installed Playwright Trace Viewer in headless Chromium.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';
import { archive, artifactModules } from './artifact-harness.mjs';
const require = createRequire(new URL('../../apps/api/package.json', import.meta.url));
const root = path.resolve('tests/workflows/.scratch/trace-live');
const capture = path.join(root, 'runner-logs', 'run'); await fs.mkdir(capture, { recursive: true });
const tokens = { bearer: 'live-bearer-71935', key: 'live-api-key-32914', cookie: 'live-cookie-82413', password: 'live-password-93413', username: 'live-user-82234', urlpass: 'live-urlpass-14923', state: 'live-state-92834', response: 'live-response-82149', custom: 'live-project-secret-94723', snapshot: 'live-snapshot-31384', metadata: 'live-metadata-48343' };
const target = http.createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  if (req.url.startsWith('/api')) { res.setHeader('Content-Type', 'application/json'); res.setHeader('Set-Cookie', `session=${tokens.cookie}`); return res.end(JSON.stringify({ password: tokens.password, privateData: tokens.response, opaque: tokens.custom, request: Buffer.concat(chunks).toString() })); }
  res.setHeader('Content-Type', 'text/html'); res.end(`<!doctype html><title>${tokens.metadata}</title><h1>${tokens.snapshot}</h1><input type="password" id="password"><button>Submit</button>`);
});
let browser, viewer, app;
try {
  await new Promise(resolve => target.listen(0, '127.0.0.1', resolve)); const base = `http://127.0.0.1:${target.address().port}`;
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${tokens.bearer}`, 'X-API-Key': tokens.key }, storageState: { cookies: [{ name: 'session', value: tokens.cookie, domain: '127.0.0.1', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' }], origins: [{ origin: base, localStorage: [{ name: 'auth', value: tokens.state }] }] } });
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true, title: tokens.metadata });
  const page = await context.newPage();
  await page.goto(base.replace('http://', `http://${tokens.username}:${tokens.urlpass}@`) + `/?key=${tokens.key}`);
  await page.locator('#password').fill(tokens.password);
  await page.evaluate(async ({ password, custom, state, base }) => { localStorage.setItem('auth', state); await fetch(base + '/api', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password, custom }) }); }, { ...tokens, base });
  await context.storageState(); await page.locator('button').click();
  await page.locator('#missing').click({ timeout: 100 }).catch(() => {});
  const rawFile = path.join(capture, 'trace.zip'); await context.tracing.stop({ path: rawFile }); await context.close();
  const raw = await fs.readFile(rawFile), rawMembers = archive.readTraceArchive(raw);
  for (const [category, token] of Object.entries(tokens)) assert.ok(rawMembers.some(m => m.data.includes(Buffer.from(token))), `Raw fixture is missing category ${category}`);
  const prisma = { projectSecret: { findMany: async () => [{ value: tokens.custom }] }, testRun: { findUnique: async () => ({ id: 'run', projectId: 'project', project: { ownerId: 'owner' } }) } };
  const modules = artifactModules(prisma, root, { decryptSecret: value => value });
  app = require('fastify')(); await app.register(modules.routes.artifactRoutes, { roots: [path.join(root, 'runner-logs')] });
  const response = await app.inject({ url: '/runner-logs/run/trace.zip', headers: { 'x-user-id': 'owner' } });
  assert.equal(response.statusCode, 200, response.body.slice(0, 200));
  const safeFile = path.join(root, 'sanitized.zip'); await fs.writeFile(safeFile, response.rawPayload);
  assert.deepEqual(await fs.readFile(rawFile), raw);
  for (const member of archive.readTraceArchive(response.rawPayload)) for (const token of Object.values(tokens)) for (const value of [token, encodeURIComponent(token), Buffer.from(token).toString('base64')]) assert.equal(member.data.includes(Buffer.from(value)), false, 'Sensitive fixture value survived sanitization');
  const playwrightRoot = path.dirname(require.resolve('playwright-core/package.json'));
  const { startTraceViewerServer } = require(path.join(playwrightRoot, 'lib/server/trace/viewer/traceViewer.js'));
  viewer = await startTraceViewerServer({ host: '127.0.0.1', port: 0 });
  const inspect = await browser.newPage({ viewport: { width: 1600, height: 1000 } }); const errors = [];
  inspect.on('pageerror', error => errors.push(error.message));
  await inspect.goto(`${viewer.urlPrefix('precise')}/trace/index.html?trace=${encodeURIComponent(`file?path=${encodeURIComponent(safeFile)}`)}`);
  await inspect.getByText('Sanitized trace', { exact: false }).first().waitFor({ timeout: 30000 });
  await inspect.getByRole('tab', { name: /Network/ }).click();
  await inspect.getByText('redacted.invalid', { exact: false }).first().waitFor({ timeout: 15000 });
  assert.ok((await inspect.locator('body').innerText()).includes('Frame.fill'));
  await inspect.getByRole('tab', { name: /^Errors/ }).click();
  await inspect.getByText('Action failed; sensitive error details withheld.', { exact: false }).first().waitFor();
  await inspect.screenshot({ path: path.join(root, 'trace-viewer.png'), fullPage: true });
  assert.deepEqual(errors, []);
  console.log('PASS: real recorded trace downloaded as a separate sanitized archive; all credential categories absent from every member; original unchanged; installed Trace Viewer opens actions and network without errors.');
} finally { await app?.close(); await viewer?.stop(); await browser?.close(); target.closeAllConnections(); await new Promise(resolve => target.close(resolve)); }
