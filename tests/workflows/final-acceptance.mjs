// Targeted acceptance only. Real application workers, disposable DB/Redis,
// loopback target and synthetic credentials. Never selects the application DB.
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { loadTs } from './operator-harness.mjs';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const require = createRequire(new URL('../../apps/api/package.json', import.meta.url));
export async function finalAcceptance({ root, databaseUrl, redisPort }) {
  const scratch = path.join(root, 'tests/workflows/.scratch/final'); await fs.mkdir(scratch, { recursive: true });
  const emptyEnv = path.join(scratch, 'empty.env'); await fs.writeFile(emptyEnv, '');
  const env = { ...process.env, DOTENV_CONFIG_PATH: emptyEnv, DATABASE_URL: databaseUrl, DIRECT_URL: databaseUrl, REDIS_URL: `redis://127.0.0.1:${redisPort}`, SECRET_KEY: crypto.randomBytes(32).toString('hex'), CLERK_PUBLISHABLE_KEY: 'fixture-only', CLERK_SECRET_KEY: 'fixture-only', OPENAI_API_KEY: 'fixture-local-only', OPENAI_BASE_URL: 'http://127.0.0.1:1/v1', TM_AUTONOMOUS_QA_ENABLED: 'true', TM_ALLOW_PRIVATE_OUTBOUND: 'true', ENABLE_AI_ANALYSIS: 'false', TM_SKIP_INSTALL: '1', TM_REUSE_WORKSPACE: '1', TM_DEBUG_SPAWN: '0', TM_TEST_TIMEOUT_MS: '5000', TM_ACTION_TIMEOUT_MS: '1500', TM_EXPECT_TIMEOUT_MS: '1000', TM_WORKERS: '1', TM_AUTH_STORAGE: path.join(scratch, 'nonexistent-auth.json'), E2E_EMAIL: '', E2E_PASS: '', TM_BASE_URL: '', BASE_URL: '', TM_GENERATED_ROOT: path.join(root, '.tmp/final-generated'), TM_CURATED_ROOT: path.join(scratch, 'curated'), TM_REPORT_ROOT: scratch, TM_AUTH_SESSION_ROOT: path.join(scratch, 'auth'), TM_LIVE_SECURITY_ROOT: path.join(scratch, 'security') };
  env.SECRET_KEY = crypto.randomBytes(32).toString('base64');
  env.TM_GENERATED_ROOT = path.join(root, 'testmind-acceptance-generated');
  env.NODE_ENV = 'production'; // Quiet Prisma logging in the isolated child only.
  env.CHECKPOINT_DISABLE = '1';
  env.PRISMA_HIDE_UPDATE_MESSAGE = '1';
  execFileSync(process.execPath, [require.resolve('prisma/build/index.js'), 'db', 'push', '--skip-generate', '--schema', path.join(root, 'apps/api/prisma/schema.prisma')], { cwd: root, env, windowsHide: true, stdio: 'pipe', timeout: 180000 });
  const log = await fs.open(path.join(scratch, 'chain.log'), 'w');
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', 'tests/workflows/final-acceptance.mjs', '--chain-child'], { cwd: root, env, windowsHide: true, stdio: ['ignore', log.fd, log.fd] });
      child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Chain harness exit ${code}; see local chain.log`)));
    });
  } catch (error) { await fs.writeFile(path.join(scratch, 'chain-result.json'), JSON.stringify({ status: 'BLOCKED', reason: error.message })); }
  finally { await log.close(); }
  if (process.argv.includes('--chain-only')) {
    const prior = JSON.parse(await fs.readFile(path.join(scratch, 'results.json'), 'utf8'));
    prior.chain = JSON.parse(await fs.readFile(path.join(scratch, 'chain-result.json'), 'utf8'));
    await fs.writeFile(path.join(scratch, 'results.json'), JSON.stringify(prior, null, 2));
    console.log(`CHAIN RETEST: ${prior.chain.status}`);
    if (prior.chain.status !== 'PASS') process.exitCode = 2;
    return;
  }
  const { artifactConfidentiality } = await import('./final-artifacts.mjs');
  const matrix = await artifactConfidentiality(root, scratch);
  const chain = JSON.parse(await fs.readFile(path.join(scratch, 'chain-result.json'), 'utf8'));
  await fs.writeFile(path.join(scratch, 'results.json'), JSON.stringify({ chain, artifactMatrix: matrix, recommendation: 'NOT ACCEPTED' }, null, 2));
  console.log(`FINAL CHECK: chain=${chain.status}; artifact checks=${matrix.length}; failures=${matrix.filter(row => row.status !== 'PASS').length}`);
  if (chain.status !== 'PASS' || matrix.some(row => row.status !== 'PASS')) process.exitCode = 2;
}

async function chainChild() {
  const root = process.cwd(), scratch = process.env.TM_REPORT_ROOT;
  const { prisma } = await import('../../apps/api/src/prisma.ts');
  const queue = await import('../../apps/api/src/runner/queue.ts');
  const { redis } = await import('../../apps/api/src/runner/redis.ts');
  const { operatorWorker } = await import('../../apps/api/src/runner/operator-worker.ts');
  const { worker } = await import('../../apps/api/src/runner/worker.ts');
  const { selfHealWorker } = await import('../../apps/api/src/runner/self-heal-worker.ts');
  for (const w of [worker, operatorWorker, selfHealWorker]) w.on('error', () => {});
  let changed = false, requests = 0;
  const server = http.createServer(async (req, res) => {
    if (req.url === '/v1/chat/completions') {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const payload = JSON.parse(Buffer.concat(chunks).toString());
      const spec = await fs.readFile(path.join(process.env.TM_GENERATED_ROOT, 'playwright-ts-final-owner/final-project/home.spec.ts'), 'utf8');
      const structured = JSON.stringify(payload.messages).includes('operations');
      // Deterministic provider fixture for this controlled application's known
      // controls. Replace only explicit missing-action diagnostics; keep assertions.
      const operations = [...spec.matchAll(/await Promise\.reject\(new Error\((.+)\)\);/g)].map(match => {
        const diagnostic = JSON.parse(JSON.parse(match[1]));
        assert.equal(diagnostic.code, 'GENERATED_LOCATOR_MISSING');
        assert.ok(['fill', 'click'].includes(diagnostic.action));
        return { type: 'replace_literal', find: match[0], replace: diagnostic.action === 'fill'
          ? 'await page.getByLabel("Email", { exact: true }).fill("qa@example.test");'
          : 'await page.getByRole("button", { name: "Continue", exact: true }).click();' };
      });
      assert.ok(operations.length && JSON.stringify(payload.messages).includes('GENERATED_LOCATOR_MISSING'));
      let updatedSpec = spec; for (const op of operations) updatedSpec = updatedSpec.replace(op.find, op.replace);
      const content = structured ? { summary: 'Restore required generated actions for observed fixture controls', operations } : { summary: 'Restore required generated actions for observed fixture controls', updatedSpec };
      res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ id: 'fixture-completion', object: 'chat.completion', created: 1, model: 'fixture', choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(content) }, finish_reason: 'stop' }] }));
    }
    requests++; res.setHeader('Content-Type', 'text/html');
    res.end(`<!doctype html><title>Fixture</title><h1>Fixture</h1><form><label for="${changed ? 'contact' : 'email'}">Email</label><input name="${changed ? 'contact' : 'email'}" id="${changed ? 'contact' : 'email'}" type="email" required><button type="submit">Continue</button></form><script>document.querySelector('input').addEventListener('invalid',()=>{document.body.append('This field is required');},{once:true});document.querySelector('form').onsubmit=e=>{e.preventDefault();document.body.append('Submitted successfully');};</script>`);
  });
  let job, timer, app;
  const scenarios = [];
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const baseUrl = `http://127.0.0.1:${server.address().port}`;
    process.env.OPENAI_BASE_URL = `${baseUrl}/v1`;
    await prisma.user.create({ data: { id: 'final-owner' } });
    await prisma.project.create({ data: { id: 'final-project', name: 'Final fixture', ownerId: 'final-owner', repoUrl: baseUrl } });
    const operatorRoutes = loadTs('apps/api/src/routes/operator.ts', { '@clerk/fastify': { getAuth: req => ({ userId: req.headers['x-user-id'] }) }, zod: require('zod'), '@prisma/client': require('@prisma/client'), '../prisma.js': { prisma }, '../runner/queue.js': queue, '../lib/artifact-references.js': await import('../../apps/api/src/lib/artifact-references.ts') });
    app = require('fastify')(); await app.register(operatorRoutes.default);
    for (const decision of ['approve', 'deny']) {
    changed = false; const priorRuns = await prisma.testRun.count({ where: { projectId: 'final-project' } });
    const resolved = [];
    job = await prisma.operatorJob.create({ data: { projectId: 'final-project', requestedBy: 'final-owner', type: 'qa', contextJson: { autonomous: true, autonomyLevel: 'autonomous-recovery', repairApprovalRequired: true, baseUrl, maxPages: 1, enableGitHubWriteback: false } } });
    timer = setInterval(async () => { if (await prisma.testRun.count({ where: { projectId: 'final-project' } }) > priorRuns) changed = true; }, 100);
    await queue.enqueueOperatorJob(job.id, { durable: true });
    const deadline = Date.now() + 300000;
    while (Date.now() < deadline) {
      const current = await prisma.operatorJob.findUnique({ where: { id: job.id } });
      const pending = await prisma.operatorApproval.findMany({ where: { jobId: job.id, status: 'pending' } });
      for (const approval of pending) {
        const attempt = await prisma.testHealingAttempt.findUniqueOrThrow({ where: { id: approval.contextJson.attemptId } });
        assert.equal(await fs.readFile(attempt.targetSpec, 'utf8'), attempt.originalSpec, 'Unapproved proposal modified original source');
        const url = `/operator/approvals/${approval.id}/${decision}`;
        assert.equal((await app.inject({ method: 'POST', url, headers: { 'x-user-id': 'foreign' } })).statusCode, 403);
        assert.equal((await app.inject({ method: 'POST', url, headers: { 'x-user-id': 'final-owner' } })).statusCode, 200);
        assert.equal((await app.inject({ method: 'POST', url, headers: { 'x-user-id': 'final-owner' } })).statusCode, 409);
        resolved.push({ attemptId: attempt.id, path: attempt.targetSpec, originalDigest: crypto.createHash('sha256').update(attempt.originalSpec).digest('hex') });
      }
      if (['succeeded', 'failed', 'canceled'].includes(current.status) && current.contextJson?._rollup) break;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    const observed = await prisma.operatorJob.findUnique({ where: { id: job.id }, include: { tasks: true } });
    const runs = await prisma.testRun.findMany({ where: { projectId: 'final-project' }, include: { results: true }, orderBy: { createdAt: 'asc' } });
    const attempts = await prisma.testHealingAttempt.findMany({ where: { testResult: { run: { projectId: 'final-project' } } } });
    const approvals = await prisma.operatorApproval.findMany({ where: { jobId: job.id } });
    const scenarioRuns = runs.slice(priorRuns);
    const scenarioAttempts = attempts.filter(a => scenarioRuns.some(r => r.id === a.runId));
    const fullTask = observed.tasks.find(t => t.inputJson?.phase === 'full-suite-verification');
    const fullRun = scenarioRuns.find(r => r.id === fullTask?.testRunId);
    const response = await app.inject({ url: `/operator/jobs/${job.id}`, headers: { 'x-user-id': 'final-owner' } });
    const report = response.json();
    const counts = observed.tasks.reduce((out, task) => { out[task.status] = (out[task.status] ?? 0) + 1; return out; }, {});
    const reportingVerified = response.statusCode === 200 && report.job?.status === observed.status &&
      Object.entries(counts).every(([key, count]) => report.rollup?.taskCounts?.[key] === count) &&
      (report.rollup?.repairCount ?? 0) === scenarioAttempts.filter(a => a.status === 'succeeded').length &&
      scenarioRuns.every(r => report.rollup?.linkedRunIds?.includes(r.id)) &&
      observed.tasks.every(t => report.job.tasks.some(item => item.id === t.id && item.status === t.status));
    let verified = resolved.length > 0;
    if (decision === 'deny') {
      for (const item of resolved) verified &&= crypto.createHash('sha256').update(await fs.readFile(item.path)).digest('hex') === item.originalDigest;
      verified &&= observed.status === 'failed' && approvals.every(a => a.status === 'denied') &&
        scenarioAttempts.every(a => a.status !== 'succeeded') &&
        !observed.tasks.some(t => t.inputJson?.phase === 'targeted-verification') &&
        scenarioRuns.length === 2 && scenarioRuns.every(r => r.status === 'failed');
    } else {
      verified &&= observed.status === 'succeeded' && approvals.length === 1 && approvals[0].status === 'approved' &&
        scenarioAttempts.length === 1 && scenarioAttempts[0].status === 'succeeded' &&
        observed.tasks.some(t => t.inputJson?.phase === 'targeted-verification' && t.status === 'succeeded') &&
        fullTask?.status === 'succeeded' && fullTask.outputJson?.qualityGate?.passed === true &&
        fullRun?.status === 'succeeded' && fullRun.results.length === 3 && fullRun.results.every(r => r.status === 'passed') &&
        fullTask.outputJson.summary.passed === 3 && fullTask.outputJson.summary.failed === 0 && fullTask.outputJson.summary.skipped === 0;
    }
    verified &&= reportingVerified;
    const result = { status: verified ? 'PASS' : 'FAIL', decision, jobId: job.id, workerStatus: observed.status, requests, stages: observed.tasks.map(t => ({ type: t.type, status: t.status, input: t.inputJson, output: t.outputJson, error: t.error })), runs: runs.map(r => ({ id: r.id, status: r.status, error: r.error, tests: r.results.map(t => ({ status: t.status, message: t.message })) })), repairs: attempts.map(a => ({ status: a.status, summary: a.summary })), approvals: approvals.map(a => ({ status: a.status, actionType: a.actionType })), reason: verified ? 'Observed decision and required source/execution checks passed' : 'Required proposal/decision/re-execution evidence missing' };
    scenarios.push(result); clearInterval(timer);
    result.reportingVerified = reportingVerified;
    result.runs = result.runs.filter(r => scenarioRuns.some(current => current.id === r.id));
    result.repairs = scenarioAttempts.map(a => ({ status: a.status, summary: a.summary }));
    result.rollup = report.rollup;
    result.finalExecution = fullTask?.status === 'succeeded' && fullRun?.status === 'succeeded' ? 'PASS' : 'FAIL';
    result.repairDecisions = resolved.map(({ attemptId, originalDigest }) => ({ attemptId, originalDigest, decision }));
    await fs.writeFile(path.join(scratch, 'chain-result.json'), JSON.stringify({ status: scenarios.length === 2 && scenarios.every(s => s.status === 'PASS') ? 'PASS' : 'FAIL', scenarios }, null, 2));
    console.log(`Chain observation: ${observed.status}; tasks=${observed.tasks.length}; runs=${runs.length}; repairs=${attempts.length}; approvals=${approvals.length}`);
    if (!resolved.length || !['succeeded', 'failed'].includes(observed.status)) break;
    }
  } finally {
    clearInterval(timer);
    if (job) {
      await prisma.operatorJob.updateMany({ where: { id: job.id, status: { in: ['queued', 'running'] } }, data: { status: 'canceled' } });
      for (const run of await prisma.testRun.findMany({ where: { projectId: 'final-project', status: { in: ['queued', 'running'] } } })) await redis.set(`cancel:run:${run.id}`, '1');
    }
    await app?.close(); await Promise.all([operatorWorker.close(), worker.close(), selfHealWorker.close()]);
    for (const value of Object.values(queue)) if (value && typeof value.close === 'function') await value.close();
    redis.disconnect(); await prisma.$disconnect(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
}
if (process.argv.includes('--chain-child')) chainChild().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
