// Reuses the existing real editor fixture; only Python-node interactions run.
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(path.join(root, 'apps/web/package.json'));
const { build } = await import(pathToFileURL(require.resolve('vite')).href);
const react = (await import(pathToFileURL(require.resolve('@vitejs/plugin-react')).href)).default;
const bundle = await build({ logLevel: 'error', configFile: false, envDir: false, root: path.join(root, 'apps/web'), plugins: [react()],
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  resolve: { alias: ['react', 'react-dom', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom/client'].map(name => ({ find: new RegExp(`^${name}$`), replacement: require.resolve(name) })) },
  build: { write: false, minify: false, lib: { entry: path.join(root, 'tests/workflows/editor-fixture.tsx'), formats: ['es'], name: 'WorkflowFixture' } },
});
const files = (Array.isArray(bundle) ? bundle.flatMap(item => item.output) : bundle.output);
const entry = files.find(file => file.type === 'chunk' && file.isEntry);
const styles = files.filter(file => file.fileName.endsWith('.css')).map(file => `<link rel="stylesheet" href="/${file.fileName}">`).join('');
const server = http.createServer((req, res) => {
  if (req.url === '/') { res.setHeader('Content-Type', 'text/html'); return res.end(`<!doctype html><html><head>${styles}</head><body><div id="root"></div><script type="module" src="/${entry.fileName}"></script></body></html>`); }
  const file = files.find(file => `/${file.fileName}` === req.url);
  if (!file) { res.statusCode = 404; return res.end(); }
  res.setHeader('Content-Type', file.fileName.endsWith('.css') ? 'text/css' : 'text/javascript'); res.end(file.type === 'chunk' ? file.code : file.source);
});
let browser;
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.getByLabel('Search nodes').fill('python');
  await page.getByRole('button', { name: 'Python Script python' }).click();
  const script = 'def main(inputs):\n    assert inputs["count"] > 0\n    return {"answer": inputs["count"]}\n';
  await page.getByLabel('Python script', { exact: true }).fill(script);
  await page.getByLabel('declarations', { exact: true }).fill('{"count":{"type":"number","required":true}}');
  await page.getByLabel('values value', { exact: true }).fill('{"count":4}');
  await page.getByLabel('timeoutMs', { exact: true }).fill('1500');
  assert.equal(await page.getByLabel('values source').locator('option[value="secret"]').count(), 0);
  await page.getByRole('button', { name: 'Save fixture' }).click();
  await page.reload();
  await page.locator('.wf-node').filter({ hasText: 'Python Script' }).click();
  assert.equal(await page.getByLabel('Python script', { exact: true }).inputValue(), script);
  const saved = await page.evaluate(() => window.workflowGraph.nodes.find(node => node.type === 'python.script'));
  assert.equal(saved.inputs.values.value.count, 4); assert.equal(saved.config.timeoutMs, 1500);
  assert.equal(saved.config.declarations.count.type, 'number');
  assert.deepEqual(errors, []);
  console.log('Python editor: PASS (add, multiline script, declarations, binding, timeout, save/reopen, secret binding unavailable)');
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
