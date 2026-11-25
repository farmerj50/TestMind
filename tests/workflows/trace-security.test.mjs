import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { deflateRawSync } from 'node:zlib';
import * as core from '../../packages/testmind-core/workflow/index.js';
import { loadTs } from './operator-harness.mjs';
import { archive, sanitizer, artifactModules } from './artifact-harness.mjs';
const require = createRequire(new URL('../../apps/api/package.json', import.meta.url));
const rootRequire = createRequire(import.meta.url);
const { tsImport } = rootRequire('tsx/esm/api');
const sourceExport = await tsImport(pathToFileURL(path.resolve('apps/api/src/lib/source-export.ts')).href, import.meta.url);
const capturePolicy = await tsImport(pathToFileURL(path.resolve('apps/api/src/lib/trace-capture.ts')).href, import.meta.url);
const references = await tsImport(pathToFileURL(path.resolve('apps/api/src/lib/artifact-references.ts')).href, import.meta.url);
await fs.mkdir(path.resolve('tests/workflows/.scratch'), { recursive: true });
const canaries = ['bearer-fixture-921', 'apikey-fixture-732', 'session-fixture-447', 'password-fixture-852', 'url-user-fixture-918', 'url-pass-fixture-301', 'state-fixture-593', 'response-fixture-928', 'custom-fixture-327', 'snapshot-fixture-632', 'metadata-fixture-428'];
export function traceFixture() {
  const events = [
    { type: 'context-options', version: 8, origin: 'library', browserName: 'chromium', contextId: 'ctx', wallTime: 1, monotonicTime: 1, title: canaries[10], options: { storageState: { cookies: [{ value: canaries[6] }] } } },
    { type: 'before', callId: 'call', pageId: 'page', startTime: 2, class: 'Page', method: 'fill', params: { value: canaries[3] }, title: canaries[8], beforeSnapshot: 'before' },
    { type: 'frame-snapshot', snapshot: { callId: 'call', snapshotName: 'before', pageId: 'page', frameId: 'frame', frameUrl: `https://${canaries[4]}:${canaries[5]}@example.test/${canaries[8]}?token=${canaries[0]}`, timestamp: 3, isMainFrame: true, html: ['HTML', {}, ['BODY', {}, ['INPUT', { value: canaries[9], 'data-secret': canaries[8] }], ['DIV', {}, canaries[7]], ['SCRIPT', {}, canaries[6]]]], resourceOverrides: [] } },
    { type: 'log', callId: 'call', time: 4, message: canaries.join(' ') },
    { type: 'after', callId: 'call', endTime: 5, result: { secret: canaries[8] }, error: { message: canaries[3] }, attachments: [{ name: canaries[10], base64: Buffer.from(canaries.join(' ')).toString('base64') }] },
  ];
  const network = { type: 'resource-snapshot', snapshot: { startedDateTime: '2026-11-09T00:00:00.000Z', time: 1, _monotonicTime: 1, request: { method: 'POST', url: `https://${canaries[4]}:${canaries[5]}@example.test/?key=${canaries[1]}`, headers: [{ name: 'Authorization', value: `Bearer ${canaries[0]}` }, { name: 'X-API-Key', value: canaries[1] }, { name: 'Cookie', value: canaries[2] }], cookies: [{ value: canaries[2] }], postData: { mimeType: 'application/json', text: JSON.stringify({ password: canaries[3], opaque: canaries[8] }), _sha1: 'request-body' } }, response: { status: 500, headers: [{ name: 'Set-Cookie', value: canaries[2] }], content: { text: canaries[7], _sha1: 'response-body' } }, timings: { wait: 1 } } };
  return [
    { name: 'trace.trace', data: Buffer.from(events.map(JSON.stringify).join('\n')) },
    { name: 'trace.network', data: Buffer.from(JSON.stringify(network)) },
    { name: 'trace.stacks', data: Buffer.from(JSON.stringify({ files: [canaries[10]], stacks: [] })) },
    { name: 'resources/request-body', data: Buffer.from(canaries.join(' ')) },
    { name: 'resources/response-body', data: Buffer.from(canaries[7]) },
    { name: 'resources/screenshot.png', data: Buffer.from(canaries[9]) },
  ];
}
test('strict trace projection removes credentials from every emitted archive member while preserving failure/timing/DOM topology', () => {
  const original = archive.writeTraceArchive(traceFixture()), saved = Buffer.from(original);
  const result = sanitizer.sanitizeTrace(original, [canaries[8]]);
  assert.deepEqual(original, saved); assert.notDeepEqual(result, original);
  const members = archive.readTraceArchive(result);
  for (const member of members) for (const canary of canaries) assert.equal(member.data.includes(Buffer.from(canary)), false);
  assert.ok(members.every(member => /\.(trace|network)$/.test(member.name)));
  const events = members[0].data.toString().trim().split('\n').map(JSON.parse);
  assert.equal(events.find(e => e.type === 'after').endTime, 5);
  assert.ok(events.find(e => e.type === 'after').error);
  assert.equal(events.find(e => e.type === 'frame-snapshot').snapshot.html[2][2][0], 'INPUT');
  const network = JSON.parse(members[1].data.toString()); assert.equal(network.snapshot.response.status, 500); assert.equal(network.snapshot.request.method, 'POST');
});
test('recorder empty DOM nodes without an attribute object remain supported', () => {
  const entries = traceFixture(); const records = entries[0].data.toString().split('\n').map(JSON.parse);
  records.find(r => r.type === 'frame-snapshot').snapshot.html = ['HTML', {}, ['BODY']];
  entries[0].data = Buffer.from(records.map(JSON.stringify).join('\n'));
  assert.ok(sanitizer.sanitizeTrace(archive.writeTraceArchive(entries)).length);
});
for (const [name, change] of [
  ['unsupported version', entries => { const lines = entries[0].data.toString().split('\n'); const first = JSON.parse(lines[0]); first.version = 9; lines[0] = JSON.stringify(first); entries[0].data = Buffer.from(lines.join('\n')); }],
  ['unsupported event', entries => { entries[0].data = Buffer.concat([entries[0].data, Buffer.from('\n{"type":"future-secret-event"}')]); }],
  ['malformed JSON', entries => { entries[1].data = Buffer.from('{broken'); }],
  ['unknown member', entries => entries.push({ name: 'state.json', data: Buffer.from('{}') })],
  ['nested archive', entries => { entries[3].data = Buffer.from('PK unsafe nested zip'); }],
  ['deep data', entries => { entries[0].data = Buffer.from('{"type":"context-options","version":8,"nested":' + '['.repeat(100) + '0' + ']'.repeat(100) + '}'); }],
  ['invalid snapshot reference', entries => { const rows = entries[0].data.toString().split('\n').map(JSON.parse); rows.find(r => r.type === 'frame-snapshot').snapshot.html = [[999, 0]]; entries[0].data = Buffer.from(rows.map(JSON.stringify).join('\n')); }],
  ['recursive snapshot reference', entries => { const rows = entries[0].data.toString().split('\n').map(JSON.parse); rows.find(r => r.type === 'frame-snapshot').snapshot.html = ['BODY', {}, [[0, 0]]]; entries[0].data = Buffer.from(rows.map(JSON.stringify).join('\n')); }],
]) test(`sanitization blocks ${name} without reflecting secret values`, () => {
  const entries = traceFixture(); change(entries);
  assert.throws(() => sanitizer.sanitizeTrace(archive.writeTraceArchive(entries), canaries), error => error.code === 'ARTIFACT_SECURITY_BLOCKED' && !canaries.some(c => error.message.includes(c)));
});
for (const name of ['truncated', 'checksum', 'encrypted', 'unsupported compression', 'ZIP64', 'duplicate names', 'path traversal', 'symlink', 'compression bomb']) test(`archive parser rejects ${name}`, () => {
  let input = archive.writeTraceArchive(traceFixture()); const end = input.length - 22, cd = input.readUInt32LE(end + 16);
  if (name === 'truncated') input = input.subarray(0, input.length - 1);
  if (name === 'checksum') input[50] ^= 1;
  if (name === 'encrypted') input.writeUInt16LE(1, cd + 8);
  if (name === 'unsupported compression') input.writeUInt16LE(99, cd + 10);
  if (name === 'ZIP64') input.writeUInt16LE(45, cd + 6);
  if (name === 'duplicate names') input = archive.writeTraceArchive(traceFixture().slice(0, 1).concat([{ name: 'TRACE.trace', data: Buffer.from('{}') }]).map((m, i) => ({ ...m, name: i ? 'copyy.trace' : 'trace.trace' })));
  if (name === 'duplicate names') { const d = input.readUInt32LE(input.length - 6); const second = d + 46 + 'trace.trace'.length; input.write('trace.trace', second + 46); }
  if (name === 'path traversal') input.write('../evil.zip', cd + 46);
  if (name === 'symlink') input.writeUInt32LE((0xa000 << 16) >>> 0, cd + 38);
  if (name === 'compression bomb') input.writeUInt32LE(archive.TRACE_LIMITS.expanded + 1, cd + 24);
  assert.throws(() => archive.readTraceArchive(input), { code: 'ARTIFACT_SECURITY_BLOCKED' });
});
test('all legacy aliases authorize before read, sanitize concurrent downloads, and never fall back on failure', async () => {
  const root = await fs.mkdtemp(path.resolve('tests/workflows/.scratch/artifact-security-'));
  const runRoot = path.join(root, 'runner-logs', 'run'); await fs.mkdir(path.join(runRoot, 'allure-report'), { recursive: true });
  const original = archive.writeTraceArchive(traceFixture()); await fs.writeFile(path.join(runRoot, 'trace.zip'), original); await fs.writeFile(path.join(runRoot, 'allure-report', 'copy.dat'), original);
  const prisma = { projectSecret: { findMany: async () => [{ value: canaries[8] }] }, testRun: { findUnique: async ({ where }) => where.id === 'run' ? { id: 'run', projectId: 'project', project: { ownerId: 'owner' } } : null } };
  const { service, routes } = artifactModules(prisma, root, { decryptSecret: v => v });
  const app = require('fastify')(); await app.register(routes.artifactRoutes, { roots: [path.join(root, 'runner-logs')] });
  try {
    const urls = ['/runner-logs/run/trace.zip', '/_static/runner-logs/run/trace.zip', '/runner/runner-logs/run/trace.zip', '/assets/copy.dat'];
    for (const url of urls) {
      const denied = await app.inject({ url, headers: { 'x-user-id': 'foreign', referer: 'http://localhost/runner-logs/run/allure-report/' } }); assert.equal(denied.statusCode, 404);
      const anonymous = await app.inject({ url, headers: { referer: 'http://localhost/runner-logs/run/allure-report/' } }); assert.equal(anonymous.statusCode, 401);
    }
    const results = await Promise.all(urls.flatMap(url => Array.from({ length: 3 }, () => app.inject({ url, headers: { 'x-user-id': 'owner', referer: 'http://localhost/runner-logs/run/allure-report/' } }))));
    for (const response of results) { assert.equal(response.statusCode, 200, response.body.slice(0, 100)); assert.match(response.headers['content-disposition'], /sanitized-trace/); for (const member of archive.readTraceArchive(response.rawPayload)) for (const c of canaries) assert.equal(member.data.includes(Buffer.from(c)), false); }
    assert.deepEqual(await fs.readFile(path.join(runRoot, 'trace.zip')), original);
    await fs.writeFile(path.join(runRoot, 'trace.zip'), Buffer.from('malformed secret archive'));
    for (const url of urls.slice(0, 3)) { const response = await app.inject({ url, headers: { 'x-user-id': 'owner' } }); assert.equal(response.statusCode, 422); assert.equal(response.json().error, 'ARTIFACT_SECURITY_BLOCKED'); }
    assert.equal((await app.inject({ url: '/_static/playwright-report/data/trace.zip' })).statusCode, 422);
    await fs.writeFile(path.join(runRoot, 'member.trace'), Buffer.from('secret raw member'));
    assert.equal((await app.inject({ url: '/runner-logs/run/member.trace', headers: { 'x-user-id': 'owner' } })).statusCode, 422);
    for (const name of ['renamed.json', 'renamed.txt']) {
      await fs.writeFile(path.join(runRoot, name), traceFixture()[0].data.toString().split('\n')[0]);
      assert.equal((await app.inject({ url: `/runner-logs/run/${name}`, headers: { 'x-user-id': 'owner' } })).statusCode, 422);
    }
    assert.equal(service.publicArtifactJson({ attachments: [{ body: original.toString('base64') }] }).attachments[0].body, '[artifact content withheld]');
    await fs.writeFile(path.join(runRoot, 'report.json'), JSON.stringify({ attachments: [{ body: original.toString('base64') }], token: canaries[0] }));
    for (const url of ['/runner/test-runs/run/report.json', '/runner/tm/runs/run/tests']) {
      const response = await app.inject({ url, headers: { 'x-user-id': 'owner' } }); assert.equal(response.statusCode, 200); assert.equal(response.body.includes('UEsDB'), false); assert.equal(response.body.includes(canaries[0]), false);
      assert.equal((await app.inject({ url, headers: { 'x-user-id': 'foreign' } })).statusCode, 404);
    }
    await fs.writeFile(path.join(runRoot, 'stdout.txt'), `Authorization: Bearer ${canaries[0]}`);
    assert.equal((await app.inject({ url: '/runner/test-runs/run/logs', headers: { 'x-user-id': 'owner' } })).body.includes(canaries[0]), false);
    const outside = path.join(root, 'foreign'); await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'trace.zip'), original);
    await fs.symlink(outside, path.join(runRoot, 'link'), 'junction');
    assert.equal((await app.inject({ url: '/runner-logs/run/link/trace.zip', headers: { 'x-user-id': 'owner' } })).statusCode, 422);
    await fs.writeFile(path.join(runRoot, 'trace.zip'), original);
    prisma.projectSecret.findMany = async () => { throw new Error(canaries[8]); };
    const failed = await app.inject({ url: '/runner-logs/run/trace.zip', headers: { 'x-user-id': 'owner' } }); assert.equal(failed.statusCode, 422); assert.equal(failed.body.includes(canaries[8]), false);
  } finally { await app.close(); }
});

test('workflow artifact ownership also binds the referenced TestRun to the job project', async () => {
  let readerCalled = false;
  const handlers = new Map();
  const routes = loadTs('apps/api/src/routes/workflowGraphs.ts', { '../lib/artifact-references.js': references, '@clerk/fastify': { getAuth: () => ({ userId: 'owner' }) }, '@testmind/core/workflow': core,
    '../prisma.js': { prisma: { operatorArtifact: { findFirst: async () => ({ id: 'artifact', testRunId: 'foreign-run', job: { projectId: 'owned-project' } }) }, testRun: { findFirst: async ({ where }) => { assert.equal(where.projectId, 'owned-project'); assert.equal(where.project.ownerId, 'owner'); return null; } } } }, '../lib/crypto.js': {}, '../lib/workflow-version.js': {}, '../runner/queue.js': {}, '../lib/storageRoots.js': {}, '../lib/artifact-service.js': { downloadableArtifact: () => { readerCalled = true; } } });
  await routes.workflowGraphRoutes({ get: (url, fn) => handlers.set(url, fn), post() {} });
  let status; const reply = { code(value) { status = value; return this; }, send() {} };
  await handlers.get('/workflows/artifacts/:id')({ params: { id: 'artifact' } }, reply);
  assert.equal(status, 404); assert.equal(readerCalled, false);
});

test('generated source export omits artifact folders and rejects disguised trace content and symlinks', async () => {
  const root = await fs.mkdtemp(path.resolve('tests/workflows/.scratch/source-export-'));
  await fs.mkdir(path.join(root, 'test-results')); await fs.writeFile(path.join(root, 'test-results', 'trace.zip'), archive.writeTraceArchive(traceFixture()));
  await fs.writeFile(path.join(root, 'example.spec.ts'), "test('example', async () => {});");
  assert.deepEqual((await sourceExport.sourceBundleFiles(root)).map(f => f.name), ['example.spec.ts']);
  await fs.writeFile(path.join(root, 'trace.txt'), traceFixture()[0].data);
  await assert.rejects(sourceExport.sourceBundleFiles(root), { code: 'ARTIFACT_SECURITY_BLOCKED' });
  for (const name of ['trace.zip', 'trace.trace', 'trace.network', 'trace.stacks', 'renamed.js']) assert.throws(() => sourceExport.checkedSourceBytes(name, archive.writeTraceArchive(traceFixture())), { code: 'ARTIFACT_SECURITY_BLOCKED' });
  await assert.rejects(sourceExport.readExportSource(root, path.join(root, 'test-results', 'trace.zip')), { code: 'ARTIFACT_SECURITY_BLOCKED' });
  const outside = await fs.mkdtemp(path.resolve('tests/workflows/.scratch/source-outside-'));
  await fs.writeFile(path.join(outside, 'other.spec.ts'), 'private source'); await fs.symlink(outside, path.join(root, 'link'), 'junction');
  await assert.rejects(sourceExport.readExportSource(root, path.join(root, 'link', 'other.spec.ts')), { code: 'ARTIFACT_SECURITY_BLOCKED' });
});

test('generated file, bundle, legacy export and curated content HTTP routes cannot export trace evidence', async () => {
  const root = await fs.mkdtemp(path.resolve('tests/workflows/.scratch/source-routes-'));
  const generated = path.join(root, 'generated'), curated = path.join(root, 'curated');
  const projectRoot = path.join(generated, 'playwright-ts-owner', 'project'), suiteRoot = path.join(curated, 'owned-suite');
  for (const folder of [projectRoot, suiteRoot]) {
    await fs.mkdir(path.join(folder, 'test-results'), { recursive: true });
    await fs.writeFile(path.join(folder, 'example.spec.ts'), "test('example', async () => {});");
    await fs.writeFile(path.join(folder, 'test-results', 'trace.zip'), archive.writeTraceArchive(traceFixture()));
  }
  const prisma = { projectSecret: { findMany: async ({ where }) => { assert.equal(where.projectId, 'project'); return []; } }, project: { findFirst: async ({ where }) => where.id === 'project' && where.ownerId === 'owner' ? { id: 'project' } : null }, curatedSuite: { findUnique: async () => ({ rootRel: 'owned-suite', name: 'Owned suite', projectId: 'project', project: { ownerId: 'owner' } }) } };
  const { service } = artifactModules(prisma, root, {});
  // Mirrors generated-files.ts's own real logic, bound to this test's temp `generated` root
  // instead of the real GENERATED_ROOT - loadTs's VM loader requires every import mocked
  // explicitly, so this isn't optional even though the real module is trivial.
  const adapterDir = (adapterId, userId) => path.join(generated, `${adapterId}-${userId}`);
  const adapterProjectDir = (adapterId, userId, projectId) => projectId ? path.join(adapterDir(adapterId, userId), projectId) : adapterDir(adapterId, userId);
  const listGeneratedSpecFiles = (adapterId, userId, projectId) => {
    let dir = adapterProjectDir(adapterId, userId, projectId);
    if (projectId && !fsSync.existsSync(dir)) { const fallback = adapterDir(adapterId, userId); if (fsSync.existsSync(fallback)) dir = fallback; }
    if (!fsSync.existsSync(dir)) return [];
    const list = [];
    const walk = (d, rel = '') => { for (const name of fsSync.readdirSync(d)) { const abs = path.join(d, name); const r = path.join(rel, name); const st = fsSync.statSync(abs); if (st.isDirectory()) walk(abs, r); else list.push({ path: r.replace(/\\/g, '/'), size: st.size }); } };
    walk(dir);
    return list;
  };
  const routes = loadTs('apps/api/src/testmind/routes.ts', { './suite-cases.js': loadTs('apps/api/src/testmind/suite-cases.ts'),
    fs: fsSync, globby: {}, archiver: require('archiver'), '@clerk/fastify': { getAuth: req => ({ userId: req.headers['x-user-id'] }) }, '../prisma.js': { prisma },
    '@testmind/core/framework': { DEFAULT_FRAMEWORK_ID: 'playwright-ts', FRAMEWORK_IDS: ['playwright-ts'] }, '@testmind/core/framework-registry': {}, './service.js': {},
    './curated-store.js': { CURATED_ROOT: curated, getCuratedProject: () => null, slugify: () => 'owned-suite', ensureWithin: (base, file) => { assert.ok(service.within(base, file)); } },
    './generated-files.js': { adapterDir, adapterProjectDir, listGeneratedSpecFiles },
    '../lib/storageRoots.js': { GENERATED_ROOT: generated }, '../lib/source-export.js': sourceExport, '../lib/artifact-service.js': service,
  });
  const app = require('fastify')(); await app.register(routes.default, { prefix: '/tm' });
  try {
    const urls = ['/tm/generated/file?projectId=project&file=test-results/trace.zip', '/tm/generated/download?projectId=project', '/tm/download?projectId=project', '/tm/suite/spec-content?projectId=owned-suite&path=test-results/trace.zip'];
    for (const url of urls) {
      assert.equal((await app.inject({ url })).statusCode, 401);
      assert.ok([403, 404].includes((await app.inject({ url, headers: { 'x-user-id': 'foreign' } })).statusCode));
    }
    for (const url of [urls[0], urls[3]]) { const response = await app.inject({ url, headers: { 'x-user-id': 'owner' } }); assert.equal(response.statusCode, 422, `${url}: ${response.body}`); }
    for (const url of [urls[1], urls[2]]) {
      const response = await app.inject({ url, headers: { 'x-user-id': 'owner' } }); assert.equal(response.statusCode, 200);
      const members = archive.readTraceArchive(response.rawPayload); assert.deepEqual(members.map(m => m.name), ['example.spec.ts']);
    }
    const source = await app.inject({ url: '/tm/generated/file?projectId=project&file=example.spec.ts', headers: { 'x-user-id': 'owner' } }); assert.equal(source.statusCode, 200);
    await fs.writeFile(path.join(projectRoot, 'disguised.txt'), traceFixture()[0].data);
    for (const url of [urls[1], urls[2], '/tm/generated/file?projectId=project&file=disguised.txt']) assert.equal((await app.inject({ url, headers: { 'x-user-id': 'owner' } })).statusCode, 422);
  } finally { await app.close(); }
});

test('historical signed/provider artifact URLs cannot be emitted as public references', () => {
  const value = references.publicArtifactReferences({ trace: 'https://storage.invalid/raw.zip?signature=private', other: ['s3://bucket/raw.zip', 'file:///raw.zip'], reportJson: 'runner-logs/run/report.json' });
  assert.equal(JSON.stringify(value).includes('signature'), false); assert.equal(value.reportJson, 'runner-logs/run/report.json');
});

test('diagnostic volume HTTP reader cannot bypass artifact policy or its existing authorization', async () => {
  const root = await fs.mkdtemp(path.resolve('tests/workflows/.scratch/debug-artifacts-'));
  const evidence = path.join(root, 'evidence'); await fs.mkdir(evidence);
  await fs.writeFile(path.join(root, 'allowed.ts'), 'export const example = true;');
  await fs.writeFile(path.join(root, 'disguised.txt'), archive.writeTraceArchive(traceFixture()));
  await fs.writeFile(path.join(evidence, 'metadata.txt'), canaries[8]);
  const { routes } = artifactModules({}, root, {}), app = require('fastify')();
  routes.registerDebugArtifactRead(app, {
    authorize: (req, reply) => { if (req.headers['x-debug-token'] === 'fixture') return true; reply.code(403).send({ error: 'Forbidden' }); return false; },
    resolvePath: value => ({ ok: true, base: root, abs: path.resolve(root, value || '') }), evidenceRoots: [evidence],
  });
  try {
    for (const file of ['allowed.ts', 'disguised.txt', 'evidence/metadata.txt']) assert.equal((await app.inject({ url: `/debug/volume/read?path=${file}` })).statusCode, 403);
    assert.equal((await app.inject({ url: '/debug/volume/read?path=allowed.ts', headers: { 'x-debug-token': 'fixture' } })).statusCode, 422);
    for (const file of ['disguised.txt', 'evidence/metadata.txt']) { const response = await app.inject({ url: `/debug/volume/read?path=${file}`, headers: { 'x-debug-token': 'fixture' } }); assert.equal(response.statusCode, 422); assert.equal(response.body.includes(canaries[8]), false); }
  } finally { await app.close(); }
});

test('capture wrapper disables embedded pixels, source and attachments without modifying original config or authentication', async () => {
  const root = await fs.mkdtemp(path.resolve('tests/workflows/.scratch/capture-policy-')), original = path.join(root, 'playwright.config.mjs');
  const source = 'export default { use: { trace: "on", storageState: "auth.json", screenshot: "only-on-failure" }, projects: [{ name: "existing", use: { trace: { mode: "retain-on-failure", screenshots: true, sources: true, attachments: true } } }] };';
  await fs.writeFile(original, source); const wrapper = await capturePolicy.createRestrictedTraceConfig(original, path.join(root, 'output'));
  try { const config = (await import(pathToFileURL(wrapper.path).href)).default; assert.equal(config.use.storageState, 'auth.json'); assert.equal(config.use.screenshot, 'only-on-failure'); for (const options of [config.use.trace, config.projects[0].use.trace]) { assert.equal(options.screenshots, false); assert.equal(options.sources, false); assert.equal(options.attachments, false); } assert.equal(config.projects[0].use.trace.mode, 'retain-on-failure'); assert.equal(await fs.readFile(original, 'utf8'), source); }
  finally { await wrapper.remove(); }
});

test('compressed member exceeding its declared output size is rejected before unbounded inflation', () => {
  const payload = deflateRawSync(Buffer.alloc(500000, 65)), name = Buffer.from('trace.trace'), local = Buffer.alloc(30), central = Buffer.alloc(46), end = Buffer.alloc(22);
  local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8); local.writeUInt32LE(payload.length, 18); local.writeUInt32LE(1, 22); local.writeUInt16LE(name.length, 26);
  central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10); central.writeUInt32LE(payload.length, 20); central.writeUInt32LE(1, 24); central.writeUInt16LE(name.length, 28);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(central.length + name.length, 12); end.writeUInt32LE(local.length + name.length + payload.length, 16);
  assert.throws(() => archive.readTraceArchive(Buffer.concat([local, name, payload, central, name, end])), { code: 'ARTIFACT_SECURITY_BLOCKED' });
});
