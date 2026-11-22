import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { inflateRawSync } from 'node:zlib';

function zipContains(buffer, needle) {
  // Inspect bounded text entries from this test's Playwright trace only.
  let eocd = buffer.length - 22;
  while (eocd >= 0 && buffer.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('Invalid fixture trace ZIP');
  let cursor = buffer.readUInt32LE(eocd + 16);
  for (let index = 0; index < buffer.readUInt16LE(eocd + 10); index++) {
    const method = buffer.readUInt16LE(cursor + 10), compressed = buffer.readUInt32LE(cursor + 20), size = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28), extra = buffer.readUInt16LE(cursor + 30), comment = buffer.readUInt16LE(cursor + 32);
    const offset = buffer.readUInt32LE(cursor + 42), name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString();
    if (size < 5_000_000 && !/\.(png|jpeg|jpg)$/i.test(name)) {
      const start = offset + 30 + buffer.readUInt16LE(offset + 26) + buffer.readUInt16LE(offset + 28);
      const bytes = buffer.subarray(start, start + compressed);
      const content = method === 0 ? bytes : method === 8 ? inflateRawSync(bytes, { maxOutputLength: 5_000_000 }) : Buffer.alloc(0);
      if (content.toString().includes(needle)) return true;
    }
    cursor += 46 + nameLength + extra + comment;
  }
  return false;
}

export async function uiAcceptance({ root, scratch, prisma, app, loadTs, baseUrl, httpRun, pass, knownGap }) {
  const require = createRequire(path.join(root, 'package.json'));
  const { tsImport } = require('tsx/esm/api');
  const source = relative => tsImport(pathToFileURL(path.join(root, relative)).href, import.meta.url);
  const { discoverSite, buildLocatorStoreFromScans } = await source('apps/api/src/testmind/discover.ts');
  const { generatePlan } = await source('apps/api/src/testmind/pipeline/generate-plan.ts');
  const { writeSpecsFromPlan } = await source('apps/api/src/testmind/pipeline/codegen.ts');
  const { createRestrictedTraceConfig } = await source('apps/api/src/lib/trace-capture.ts');
  const discovery = await discoverSite(baseUrl, [], { maxPages: 1, signal: AbortSignal.timeout(30000), validateRequest: async url => { assert.equal(new URL(url).origin, baseUrl); } });
  assert.ok(discovery.scans.length);
  const plan = generatePlan({ env: { baseUrl }, component: { id: 'fixture-project', type: 'UI' }, requirement: { id: 'audit', title: 'Acceptance UI', priority: 'P2' }, risks: { likelihood: 0.3, impact: 0.5 }, discovered: { routes: discovery.scans.map(scan => scan.url), forms: discovery.forms, scans: discovery.scans } }, 'sdet');
  assert.ok(plan.cases.length); plan.cases = plan.cases.slice(0, 2);
  const directory = path.join(root, '.tmp', `workflow-ui-acceptance-${Date.now()}`); await fs.mkdir(directory, { recursive: true });
  await writeSpecsFromPlan(directory, plan, 'playwright-ts', { baseUrl, locatorStore: buildLocatorStoreFromScans(discovery.scans) });
  const testRun = await prisma.testRun.create({ data: { projectId: 'fixture-project', trigger: 'workflow', status: 'running' } });
  const runRoot = path.join(scratch, 'runner-logs', testRun.id); await fs.mkdir(runRoot, { recursive: true });
  const config = path.join(directory, 'playwright.config.cjs');
  await fs.writeFile(config, `module.exports = ${JSON.stringify({ testDir: directory, testMatch: '*.spec.ts', timeout: 15000, workers: 1, retries: 0, reporter: [['json', { outputFile: path.join(runRoot, 'report.json') }]], outputDir: path.join(runRoot, 'artifacts'), use: { headless: true, baseURL: baseUrl, trace: 'on', screenshot: 'on', extraHTTPHeaders: { Authorization: 'Bearer fixture-artifact-canary' } } })};`);
  const restricted = await createRestrictedTraceConfig(config, path.join(runRoot, 'artifacts'));
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [require.resolve('@playwright/test/cli'), 'test', '--config', restricted.path], { cwd: root, windowsHide: true, env: { ...process.env, TM_BASE_URL: baseUrl, TM_WORKFLOW_ORIGIN: baseUrl, TM_RUN_LOG_DIR: runRoot }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', data => output += data); child.stderr.on('data', data => output += data);
    child.on('error', reject); child.on('exit', async code => { await fs.writeFile(path.join(runRoot, 'cli.log'), output); resolve(code); });
  }).finally(() => restricted.remove());
  const report = JSON.parse(await fs.readFile(path.join(runRoot, 'report.json'), 'utf8'));
  const parsers = loadTs('apps/api/src/runner/result-parsers.ts', { 'fs/promises': fs });
  const cases = await parsers.parseResults('', report);
  assert.equal(exitCode, 0, JSON.stringify(cases)); assert.ok(cases.length); assert.ok(cases.every(test => test.status === 'passed'));
  const attachments = cases.flatMap(test => test.attachments ?? []);
  const trace = attachments.find(item => item.name === 'trace'); assert.ok(trace?.path);
  assert.ok(attachments.some(item => item.contentType?.startsWith('image/')));
  const resultIds = [];
  for (const test of cases) {
    const tc = await prisma.testCase.create({ data: { projectId: 'fixture-project', title: test.fullName, key: `audit-${testRun.id}-${resultIds.length}` } });
    const result = await prisma.testResult.create({ data: { runId: testRun.id, testCaseId: tc.id, status: test.status, durationMs: test.durationMs ?? 0 } }); resultIds.push(result.id);
  }
  await prisma.testRun.update({ where: { id: testRun.id }, data: { status: 'succeeded', finishedAt: new Date() } });
  pass('Real UI discovery and existing generator produce passing Playwright CLI tests, screenshots, traces, and parseable evidence (CLI, not the full UI worker)');
  const task = await prisma.operatorTask.findFirst({ where: { workflowRunId: httpRun.id } });
  const collector = loadTs('apps/api/src/runner/workflow-evidence-collector.ts', { 'node:fs/promises': fs, '../prisma.js': { prisma }, '../lib/storageRoots.js': { REPORT_ROOT: scratch }, './result-parsers.js': parsers });
  const evidence = await collector.collectWorkflowRunEvidence('fixture-project', { runId: testRun.id, source: 'ui' }, httpRun.operatorJobId, task.id);
  assert.ok(evidence.some(item => item.kind === 'trace' && item.artifactId));
  assert.ok(evidence.some(item => item.kind === 'screenshot' && item.artifactId));
  pass('Actual evidence collector associates generated screenshots, trace and page signals with the persisted test cases');
  const artifact = await prisma.operatorArtifact.create({ data: { jobId: httpRun.operatorJobId, taskId: task.id, testRunId: testRun.id, type: 'trace', path: trace.path } });
  const foreign = await app.inject({ method: 'GET', url: `/workflows/artifacts/${artifact.id}`, headers: { 'x-user-id': 'foreign-user' } }); assert.equal(foreign.statusCode, 404);
  const downloaded = await app.inject({ method: 'GET', url: `/workflows/artifacts/${artifact.id}`, headers: { 'x-user-id': 'fixture-owner' } });
  assert.equal(downloaded.statusCode, 200);
  assert.equal(zipContains(await fs.readFile(trace.path), 'fixture-artifact-canary'), true, 'Original trace must exercise the credential exposure');
  assert.equal(zipContains(downloaded.rawPayload, 'fixture-artifact-canary'), false, 'Sanitized trace must not contain runtime credentials');
  assert.match(downloaded.headers['content-disposition'], /sanitized-trace/);
  const relative = path.relative(path.join(scratch, 'runner-logs'), trace.path).split(path.sep).map(encodeURIComponent).join('/');
  for (const prefix of ['/runner-logs/', '/_static/runner-logs/', '/runner/runner-logs/']) {
    const copy = await app.inject({ method: 'GET', url: prefix + relative, headers: { 'x-user-id': 'fixture-owner' } });
    assert.equal(copy.statusCode, 200); assert.deepEqual(copy.rawPayload, downloaded.rawPayload);
    assert.equal((await app.inject({ method: 'GET', url: prefix + relative, headers: { 'x-user-id': 'foreign-user' } })).statusCode, 404);
  }
  await fs.writeFile(path.join(scratch, 'sanitized-live-trace.zip'), downloaded.rawPayload);
  pass('SEC-ARTIFACT: original trace contains the credential; workflow and every runner alias return a separate validated sanitized copy with no credential');
  pass('Artifact download denies foreign project owner');
  const apiRequire = createRequire(path.join(root, 'apps/api/package.json'));
  const policy = loadTs('apps/api/src/ai/core/repair-policy.ts', { diff: apiRequire('diff'), typescript: apiRequire('typescript'), '@testmind/core/framework': { DEFAULT_FRAMEWORK_ID: 'playwright-ts' } });
  const before = "test('checkout', async ({page}) => { await expect(page.locator('#submit')).toBeVisible(); });";
  const after = "test('checkout', async ({page}) => { await page.waitForTimeout(1); });";
  if (policy.validatePatchedSpec(before, after, 'playwright-ts', { maxChangedLines: 220, maxBytesDelta: 28000 }) === null) knownGap('QA-INTENT', 'Existing repair validator accepts removing the only assertion while retaining the test title');
  else pass('Repair validator rejects assertion removal');
}
