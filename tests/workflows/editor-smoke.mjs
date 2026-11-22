// Isolated component browser test: no application server, auth, DB or secrets.
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import { chromium } from 'playwright';
const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(path.join(root, 'apps/web/package.json'));
const { build } = await import(pathToFileURL(require.resolve('vite')).href);
const react = (await import(pathToFileURL(require.resolve('@vitejs/plugin-react')).href)).default;
const bundle = await build({ configFile: false, envDir: false, root: path.join(root, 'apps/web'), plugins: [react()],
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  resolve: { alias: [{ find: /^react$/, replacement: require.resolve('react') }, { find: /^react-dom$/, replacement: require.resolve('react-dom') }, { find: /^react\/jsx-runtime$/, replacement: require.resolve('react/jsx-runtime') }, { find: /^react\/jsx-dev-runtime$/, replacement: require.resolve('react/jsx-dev-runtime') }, { find: /^react-dom\/client$/, replacement: require.resolve('react-dom/client') }] },
  build: { write: false, minify: false, lib: { entry: path.join(root, 'tests/workflows/editor-fixture.tsx'), formats: ['es'], name: 'WorkflowFixture' } },
});
const files = (Array.isArray(bundle) ? bundle.flatMap(item => item.output) : bundle.output);
const entry = files.find(file => file.type === 'chunk' && file.isEntry);
const styles = files.filter(file => file.fileName.endsWith('.css')).map(file => `<link rel="stylesheet" href="/${file.fileName}">`).join('');
const server = http.createServer((req, res) => {
  if (req.url === '/workflow-fixture') { res.setHeader('Content-Type', 'text/html'); return res.end(`<!doctype html><html><head>${styles}</head><body style="margin:0;font-family:Arial"><div id="root"></div><script type="module" src="/${entry.fileName}"></script></body></html>`); }
  const file = files.find(file => `/${file.fileName}` === req.url);
  if (!file) { res.statusCode = 404; return res.end(); }
  res.setHeader('Content-Type', file.fileName.endsWith('.css') ? 'text/css' : 'text/javascript'); res.end(file.type === 'chunk' ? file.code : file.source);
});
let browser, page;
try {
  await new Promise(resolve => server.listen(5197, '127.0.0.1', resolve));
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  const pending = new Set();
  page.on('request', request => pending.add(request.url()));
  page.on('requestfinished', request => pending.delete(request.url()));
  page.on('requestfailed', request => { pending.delete(request.url()); console.error('Request failed:', request.url(), request.failure()); });
  const errors = []; page.on('pageerror', error => { errors.push(error.message); console.error('Browser error:', error.message); });
  page.on('console', message => { if (message.type() === 'error') console.error('Browser console:', message.text()); });
  await page.goto('http://127.0.0.1:5197/workflow-fixture', { waitUntil: 'commit' });
  await page.getByRole('status').filter({ hasText: 'Graph valid' }).waitFor({ timeout: 15000 }).catch(error => { console.error('Pending fixture resources:', [...pending]); throw error; });
  assert.equal(await page.locator('.react-flow__node').count(), 5);
  await page.getByLabel('Search nodes').fill('risk');
  await page.getByRole('button', { name: 'Select tests by risk autonomous' }).click();
  assert.equal(await page.locator('.react-flow__node').count(), 6);
  await page.getByRole('button', { name: 'Duplicate', exact: true }).click();
  assert.equal(await page.locator('.react-flow__node').count(), 7);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  assert.equal(await page.locator('.react-flow__node').count(), 6);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  assert.equal(await page.locator('.react-flow__node').count(), 7);
  await page.getByRole('button', { name: 'Remove node', exact: true }).click();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  assert.equal(await page.locator('.react-flow__node').count(), 7);
  await page.getByLabel('Autonomy level').selectOption('autonomous-testing');
  await page.getByRole('button', { name: 'Save fixture' }).click();
  const saved = await page.evaluate(() => JSON.stringify(window.workflowGraph));
  await page.reload();
  await page.getByLabel('Autonomy level').waitFor();
  assert.equal(await page.evaluate(() => JSON.stringify(window.workflowGraph)), saved);
  await page.getByLabel('Workflow template').selectOption('ui');
  await page.getByRole('status').filter({ hasText: 'Graph valid' }).waitFor();
  assert.equal(await page.locator('.react-flow__node').count(), 6);
  await page.getByLabel('Workflow template').selectOption('api');
  await page.locator('.react-flow__node').filter({ hasText: 'HTTP request' }).click();
  await page.getByLabel('url source').selectOption('constant');
  await page.getByLabel('url value').fill('https://example.test');
  await page.getByLabel('method', { exact: true }).selectOption('POST');
  assert.equal(await page.evaluate(() => window.workflowGraph.nodes[1].inputs.url.value), 'https://example.test');
  await page.getByLabel('bearerToken source').selectOption('secret');
  await page.getByLabel('bearerToken reference').fill('audit_secret');
  assert.equal(await page.evaluate(() => window.workflowGraph.nodes[1].inputs.bearerToken.key), 'audit_secret');
  const invalidSource = await page.locator('[data-id="step-0"] [data-handleid="out:variables"]').boundingBox();
  const invalidTarget = await page.locator('[data-id="step-1"] [data-handleid="in:url"]').boundingBox();
  await page.mouse.move(invalidSource.x + invalidSource.width / 2, invalidSource.y + invalidSource.height / 2); await page.mouse.down();
  await page.mouse.move(invalidTarget.x + invalidTarget.width / 2, invalidTarget.y + invalidTarget.height / 2, { steps: 12 }); await page.mouse.up();
  assert.equal(await page.evaluate(() => window.workflowGraph.nodes[1].inputs.url.kind), 'constant');
  const originalViewport = await page.locator('.react-flow__viewport').getAttribute('style');
  await page.getByRole('button', { name: /zoom in/i }).click();
  assert.notEqual(await page.locator('.react-flow__viewport').getAttribute('style'), originalViewport);
  await page.getByRole('button', { name: /zoom out/i }).click();
  const pane = await page.locator('.react-flow__pane').boundingBox();
  const beforePan = await page.locator('.react-flow__viewport').getAttribute('style');
  await page.mouse.move(pane.x + pane.width / 2, pane.y + pane.height - 70); await page.mouse.down();
  await page.mouse.move(pane.x + pane.width / 2 + 40, pane.y + pane.height - 40, { steps: 10 }); await page.mouse.up();
  assert.notEqual(await page.locator('.react-flow__viewport').getAttribute('style'), beforePan);
  await page.getByRole('button', { name: 'Fit view', exact: true }).click();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const source = page.locator('[data-id="step-1"] [data-handleid="exec:failure"]');
  const target = page.locator('[data-id="step-4"] [data-handleid="exec"]');
  const startBox = await source.boundingBox(), endBox = await target.boundingBox();
  await page.mouse.move(startBox.x + startBox.width / 2, startBox.y + startBox.height / 2); await page.mouse.down();
  await page.mouse.move(endBox.x + endBox.width / 2, endBox.y + endBox.height / 2, { steps: 15 }); await page.mouse.up();
  await page.waitForFunction(() => window.workflowGraph.edges.length === 5);
  const addedEdgeId = await page.evaluate(() => window.workflowGraph.edges[4].id);
  await page.locator(`.react-flow__edge[data-id="${addedEdgeId}"]`).dispatchEvent('click');
  await page.locator(`.react-flow__edge[data-id="${addedEdgeId}"]`).focus();
  await page.keyboard.press('Delete');
  await page.waitForFunction(() => window.workflowGraph.edges.length === 4);
  const heading = page.locator('[data-id="step-1"] .wf-node-heading');
  const position = await page.evaluate(() => ({ ...window.workflowGraph.nodes[1].position }));
  const headingBox = await heading.boundingBox();
  await page.mouse.move(headingBox.x + 30, headingBox.y + 12); await page.mouse.down();
  await page.mouse.move(headingBox.x + 80, headingBox.y + 42, { steps: 10 }); await page.mouse.up();
  assert.notDeepEqual(await page.evaluate(() => window.workflowGraph.nodes[1].position), position);
  await page.getByRole('button', { name: 'Save fixture' }).click();
  await page.screenshot({ path: path.join(root, 'tests/workflows/editor-smoke.png'), fullPage: true });
  assert.deepEqual(errors, []);
  console.log('Editor browser checks passed: add/search, duplicate/delete, undo/redo, save/reopen, templates, configuration, secrets, autonomy, compatible/incompatible ports, zoom/pan, remove edges and dragging.');
} catch (error) {
  if (page) { await page.screenshot({ path: path.join(root, 'tests/workflows/.scratch/editor-failure.png'), fullPage: true }); await fs.writeFile(path.join(root, 'tests/workflows/.scratch/editor-failure.html'), await page.content()); }
  throw error;
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
