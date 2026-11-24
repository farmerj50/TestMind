import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import { chromium } from 'playwright';

export async function browserAcceptance({ root, scratch, app, prisma, env, pass, waitFor }) {
  process.env.NODE_ENV = 'production'; // Test bundle runtime and JSX transform must agree.
  const require = createRequire(path.join(root, 'apps/web/package.json'));
  const { build } = await import(pathToFileURL(require.resolve('vite')).href);
  const react = (await import(pathToFileURL(require.resolve('@vitejs/plugin-react')).href)).default;
  const bundle = await build({ configFile: false, envDir: false, mode: 'production', esbuild: { jsxDev: false }, root: path.join(root, 'apps/web'), plugins: [react(), {
    name: 'audit-identity-only', enforce: 'pre', resolveId(id) { if (id === '@clerk/clerk-react') return '\0audit-auth'; },
    load(id) { if (id === '\0audit-auth') return "const getToken=async()=> 'fixture-owner'; export const useAuth=()=>({getToken});"; },
  }], define: { 'process.env.NODE_ENV': JSON.stringify('production'), 'import.meta.env.VITE_API_URL': JSON.stringify('') },
    css: { postcss: { plugins: [require('tailwindcss')({ content: [path.join(root, 'apps/web/src/**/*.{js,ts,jsx,tsx}').replaceAll('\\', '/')], theme: { extend: {} }, plugins: [] }), require('autoprefixer')()] } },
    resolve: { alias: [{ find: '@clerk/clerk-react', replacement: path.join(root, 'tests/workflows/acceptance-auth.ts') }, { find: /^react$/, replacement: require.resolve('react') }, { find: /^react-dom$/, replacement: require.resolve('react-dom') }, { find: /^react\/jsx-runtime$/, replacement: require.resolve('react/jsx-runtime') }, { find: /^react\/jsx-dev-runtime$/, replacement: require.resolve('react/jsx-dev-runtime') }, { find: /^react-dom\/client$/, replacement: require.resolve('react-dom/client') }] },
    build: { write: false, minify: false, lib: { entry: path.join(root, 'tests/workflows/acceptance-page.tsx'), formats: ['es'], name: 'WorkflowAcceptance' } },
  });
  const files = Array.isArray(bundle) ? bundle.flatMap(item => item.output) : bundle.output;
  const entry = files.find(file => file.type === 'chunk' && file.isEntry);
  const styles = files.filter(file => file.fileName.endsWith('.css')).map(file => `<link rel="stylesheet" href="/${file.fileName}">`).join('');
  const server = http.createServer(async (req, res) => {
    if (req.url === '/audit') { res.setHeader('Content-Type', 'text/html'); return res.end(`<!doctype html><html><head>${styles}</head><body><div id="root"></div><script type="module" src="/${entry.fileName}"></script></body></html>`); }
    const file = files.find(file => `/${file.fileName}` === req.url);
    if (file) { res.setHeader('Content-Type', file.fileName.endsWith('.css') ? 'text/css' : 'text/javascript'); return res.end(file.type === 'chunk' ? file.code : file.source); }
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/projects') return res.end(JSON.stringify({ projects: [{ id: 'fixture-project', name: 'Fixture' }] }));
    if (req.url.startsWith('/environments?')) return res.end(JSON.stringify({ environments: await prisma.environment.findMany({ where: { projectId: 'fixture-project' } }) }));
    if (req.url === '/tm/suite/projects') return res.end(JSON.stringify({ projects: [] }));
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const payload = Buffer.concat(chunks).toString();
    const response = await app.inject({ method: req.method, url: req.url, ...(payload ? { payload } : {}), headers: { ...(payload ? { 'content-type': 'application/json' } : {}), 'x-user-id': req.headers.authorization === 'Bearer fixture-owner' ? 'fixture-owner' : '' } });
    res.statusCode = response.statusCode;
    for (const [name, value] of Object.entries(response.headers)) if (name !== 'transfer-encoding' && value !== undefined) res.setHeader(name, value);
    res.end(response.rawPayload);
  });
  let browser, page;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
    await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
    const errors = []; page.on('pageerror', error => { errors.push(error.message); console.error('Audit browser:', error.message); });
    await page.goto(`http://127.0.0.1:${server.address().port}/audit`, { waitUntil: 'commit' });
    await page.locator('[data-id="step-1"]').waitFor({ state: 'visible' });
    await page.getByPlaceholder('Smoke tests before release').fill('Browser acceptance workflow');
    await page.locator('select').filter({ has: page.locator(`option[value="${env.id}"]`) }).selectOption(env.id);
    // Parent form updates must not discard controlled-node dimensions.
    await page.locator('[data-id="step-1"]').waitFor({ state: 'visible' });
    await page.locator('[data-id="step-1"]').click();
    await page.getByLabel('bearerToken source').selectOption('secret'); await page.getByLabel('bearerToken reference').fill('audit_token');
    await page.getByLabel('url source').selectOption('environment'); await page.getByLabel('url reference').fill('baseUrl');
    await page.getByRole('button', { name: 'Create workflow', exact: true }).click();
    await waitFor(async () => !!await prisma.workflow.findFirst({ where: { name: 'Browser acceptance workflow' } }), 'Browser save did not reach database');
    let saved = await prisma.workflow.findFirst({ where: { name: 'Browser acceptance workflow' } });
    const savedGraph = saved.configJson.graph;
    assert.equal(savedGraph.nodes[1].inputs.bearerToken.kind, 'secret');
    await page.reload();
    let card = page.locator(`[data-workflow-id="${saved.id}"]`);
    await card.getByRole('button', { name: 'Edit', exact: true }).click();
    await page.locator('[data-id="step-1"]').click();
    assert.equal(await page.getByLabel('bearerToken reference').inputValue(), 'audit_token');
    await page.getByLabel('Node name').fill('Authenticated HTTP');
    await page.getByRole('button', { name: 'Save workflow version', exact: true }).click();
    await waitFor(async () => (await prisma.workflow.findUnique({ where: { id: saved.id } })).configJson.graph.nodes[1].name === 'Authenticated HTTP', 'Edit did not persist');
    saved = await prisma.workflow.findUnique({ where: { id: saved.id } });
    assert.deepEqual(saved.configJson.graph.nodes[1].position, savedGraph.nodes[1].position);
    assert.deepEqual(saved.configJson.graph.nodes[1].inputs, savedGraph.nodes[1].inputs);
    await card.getByRole('button', { name: 'Run', exact: true }).click();
    await card.getByRole('button', { name: 'Inspect nodes', exact: true }).first().click();
    const inspector = page.getByRole('region', { name: 'Workflow execution inspector' });
    await inspector.getByText('Execution details · succeeded', { exact: true }).waitFor({ timeout: 30000 });
    await inspector.getByRole('button').filter({ hasText: 'Authenticated HTTP' }).click();
    assert.ok((await inspector.innerText()).includes('"status": 200'));
    assert.equal((await inspector.innerText()).includes('fixture-canary'), false);
    assert.equal((await inspector.innerText()).includes('NaN'), false);
    const download = page.waitForEvent('download'); await inspector.getByRole('button', { name: 'Export report' }).click();
    const report = await download; await report.saveAs(path.join(scratch, 'browser-report.json'));
    await page.screenshot({ path: path.join(scratch, 'acceptance-browser.png'), fullPage: true });
    pass('Actual Workflows page saves/reopens/edits through backend contracts, executes on BullMQ, shows node status/output and exports redacted report');
    await inspector.getByRole('button', { name: 'Close details' }).click();
    await card.getByRole('button', { name: 'Edit', exact: true }).click();
    await page.locator('[data-id="step-2"]').click();
    await page.getByLabel('checks', { exact: true }).fill(JSON.stringify([{ id: 'status', operator: 'equals', path: 'status', expected: 201 }]));
    await page.getByRole('button', { name: 'Save workflow version', exact: true }).click();
    await waitFor(async () => (await prisma.workflow.findUnique({ where: { id: saved.id } })).configJson.graph.nodes[2].config.checks[0].expected === 201, 'Failure fixture edit did not persist');
    await card.getByRole('button', { name: 'Run', exact: true }).click();
    await waitFor(async () => await card.getByRole('button', { name: 'Inspect nodes', exact: true }).count() === 2, 'Second run did not appear in browser history');
    await card.getByRole('button', { name: 'Inspect nodes', exact: true }).first().click();
    await inspector.getByText('Execution details · failed', { exact: true }).waitFor({ timeout: 30000 });
    await inspector.getByRole('button').filter({ hasText: /^Assert/ }).click(); // node title of the template's assert step
    assert.ok((await inspector.innerText()).includes('"failureKind": "assertion"'));
    await page.screenshot({ path: path.join(scratch, 'acceptance-browser-failed-run.png'), fullPage: true });
    assert.deepEqual(errors, []);
    pass('Browser failure inspector displays the persisted assertion failure and keeps the failed workflow red');
  } catch (error) {
    if (page) { await page.screenshot({ path: path.join(scratch, 'acceptance-browser-failure.png') }).catch(() => {}); await fs.writeFile(path.join(scratch, 'acceptance-browser-failure.html'), await page.content().catch(() => 'unavailable')); }
    throw error;
  } finally { await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
