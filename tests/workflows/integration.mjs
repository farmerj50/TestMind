// Disposable integration test. Never reads the repository DATABASE_URL or Redis
// configuration. Containers are bound to loopback on random ports and removed.
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import * as core from '../../packages/testmind-core/workflow/index.js';
import { createOperatorHarness, loadTs } from './operator-harness.mjs';
const root = fileURLToPath(new URL('../../', import.meta.url));
// Pin the pre-Release-1 schema so this upgrade test still works after merging.
const baselineRevision = 'c696baa1f2ae8bc01f2ce0eed82c4e1c2299ab09';
const require = createRequire(path.join(root, 'apps/api/package.json'));
const tag = `testmind-r1-${crypto.randomBytes(5).toString('hex')}`;
const created = [];
let prisma, queue, redis, worker, app;
const docker = (args, input) => execFileSync('docker', args, { encoding: 'utf8', input, windowsHide: true, timeout: 60000 });
const waitFor = async (predicate, message) => { for (let i = 0; i < 120; i++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 250)); } throw new Error(message); };
const startContainer = (name, image, port, args) => { docker(['run', '--rm', '-d', '--name', name, '--label', `testmind.workflow.test=${tag}`, '-p', `127.0.0.1::${port}`, ...args, image]); created.push(name); return Number(docker(['port', name, String(port)]).trim().split(':').at(-1)); };
try {
  const pgName = `${tag}-pg`, redisName = `${tag}-redis`;
  const pgPort = startContainer(pgName, 'postgres:16-alpine', 5432, ['-e', 'POSTGRES_PASSWORD=workflow-fixture-only', '-e', 'POSTGRES_DB=workflow_r1']);
  const redisPort = startContainer(redisName, 'redis:7', 6379, []);
  await waitFor(async () => { try { docker(['exec', pgName, 'pg_isready', '-U', 'postgres', '-d', 'workflow_r1']); return true; } catch { return false; } }, 'Disposable PostgreSQL did not start');
  const databaseUrl = `postgresql://postgres:workflow-fixture-only@127.0.0.1:${pgPort}/workflow_r1`;
  assert.match(databaseUrl, /^postgresql:\/\/postgres:workflow-fixture-only@127\.0\.0\.1:\d+\/workflow_r1$/);
  if (process.argv.includes('--final-only')) {
    const { finalAcceptance } = await import('./final-acceptance.mjs');
    await finalAcceptance({ root, databaseUrl, redisPort });
  } else {
  const scratch = path.join(root, 'tests/workflows/.scratch'); fs.mkdirSync(scratch, { recursive: true });
  const schemaPath = path.join(scratch, 'baseline.prisma');
  fs.writeFileSync(schemaPath, execFileSync('git', ['show', `${baselineRevision}:apps/api/prisma/schema.prisma`], { cwd: root, encoding: 'utf8', windowsHide: true }));
  execFileSync(process.execPath, [require.resolve('prisma/build/index.js'), 'db', 'push', '--skip-generate', '--schema', schemaPath], { cwd: root, env: { ...process.env, DATABASE_URL: databaseUrl, DIRECT_URL: databaseUrl }, encoding: 'utf8', windowsHide: true, timeout: 60000 });
  const sql = text => docker(['exec', '-i', pgName, 'psql', '-U', 'postgres', '-d', 'workflow_r1', '-v', 'ON_ERROR_STOP=1'], text);
  sql(`INSERT INTO "User" (id) VALUES ('fixture-owner');
    INSERT INTO "Project" (id,name,"repoUrl","ownerId") VALUES ('fixture-project','Fixture','https://example.test','fixture-owner');
    INSERT INTO "Workflow" (id,"projectId",name,"updatedAt") VALUES ('legacy-workflow','fixture-project','Existing workflow',CURRENT_TIMESTAMP);
    INSERT INTO "WorkflowRun" (id,"workflowId",status,"updatedAt") VALUES ('legacy-run','legacy-workflow','succeeded',CURRENT_TIMESTAMP);
    UPDATE "Workflow" SET "approvalRequired"=true,"configJson"='{"legacy":{"suite":"existing-suite","keep":true}}'::jsonb WHERE id='legacy-workflow';
    INSERT INTO "WorkflowRun" (id,"workflowId",status,"requestedBy","approvedBy","updatedAt") VALUES
      ('legacy-pending','legacy-workflow','awaiting_approval','fixture-owner',NULL,CURRENT_TIMESTAMP),
      ('legacy-approved','legacy-workflow','succeeded','fixture-owner','fixture-owner',CURRENT_TIMESTAMP);`);
  sql(fs.readFileSync(path.join(root, 'apps/api/prisma/migrations/20261109120000_workflow_graph_foundation/migration.sql'), 'utf8'));
  // Apply every later migration in order (as `prisma migrate deploy` does), so the current worker
  // runs against the schema it ships with and later migrations are proven additive on this baseline.
  const migrationsDir = path.join(root, 'apps/api/prisma/migrations');
  // History-repair migrations (release commits c3dafc27 / fe39a2e1) only create objects that the
  // baseline schema already declared without a migration - exactly like databases built by
  // `db push`. On such databases they are recorded with `prisma migrate resolve --applied`, not
  // re-executed, so the fixture does the same after proving their objects already exist.
  const historyRepairs = new Map([
    ['20261122071817_add_operator_schedule_table', `SELECT to_regclass('"OperatorSchedule"') IS NOT NULL`],
    ['20261122080000_add_research_program', `SELECT to_regclass('"ResearchProgram"') IS NOT NULL`],
    ['20261122080100_add_healing_status_needs_review', `SELECT 'needs_review' = ANY(enum_range(NULL::"HealingStatus")::text[])`],
    ['20261122080200_add_testcase_and_healing_attempt_fields', `SELECT count(*) = 2 FROM information_schema.columns WHERE (table_name, column_name) IN (('TestCase', 'curatedSuiteId'), ('TestHealingAttempt', 'executionAfter'))`],
    ['20261122080300_add_agent_fingerprint_and_session_metrics', `SELECT count(*) = 2 FROM information_schema.columns WHERE (table_name, column_name) IN (('AgentPage', 'fingerprint'), ('AgentSession', 'metrics'))`],
  ]);
  for (const name of fs.readdirSync(migrationsDir).filter(n => /^\d{14}_/.test(n) && n > '20261109120000_workflow_graph_foundation').sort()) {
    if (historyRepairs.has(name)) {
      const present = docker(['exec', pgName, 'psql', '-U', 'postgres', '-d', 'workflow_r1', '-tAc', historyRepairs.get(name)]).trim();
      assert.equal(present, 't', `${name}: baseline is expected to already contain its objects`);
      continue;
    }
    sql(fs.readFileSync(path.join(migrationsDir, name, 'migration.sql'), 'utf8'));
  }
  const { PrismaClient } = require('@prisma/client');
  prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  assert.equal((await prisma.workflowRun.findUnique({ where: { id: 'legacy-run' } })).status, 'succeeded');
  assert.equal((await prisma.workflow.findUnique({ where: { id: 'legacy-workflow' } })).archivedAt, null);
  const legacy = await prisma.workflow.findUnique({ where: { id: 'legacy-workflow' } });
  assert.equal(legacy.approvalRequired, true);
  assert.deepEqual(legacy.configJson, { legacy: { suite: 'existing-suite', keep: true } });
  const pendingLegacy = await prisma.workflowRun.findUnique({ where: { id: 'legacy-pending' } });
  assert.equal(pendingLegacy.status, 'awaiting_approval'); assert.equal(pendingLegacy.requestedBy, 'fixture-owner'); assert.equal(pendingLegacy.versionId, null);
  assert.equal((await prisma.workflowRun.findUnique({ where: { id: 'legacy-approved' } })).approvedBy, 'fixture-owner');
  console.log('PASS: additive migration preserves legacy configurations, historical runs and pending/resolved workflow approvals');
  const bullmq = require('bullmq'); const Redis = require('ioredis');
  redis = new Redis({ host: '127.0.0.1', port: redisPort, maxRetriesPerRequest: null });
  queue = new bullmq.Queue('operator-jobs', { connection: redis });
  let dispatchFault;
  const enqueueOperatorJob = async id => {
    if (dispatchFault === 'before') throw new Error('Simulated crash before queue dispatch');
    const job = await queue.add('execute', { operatorJobId: id }, { jobId: id, removeOnComplete: false, attempts: 1 });
    if (dispatchFault === 'after') throw new Error('Simulated crash after queue dispatch');
    return job;
  };
  const version = loadTs('apps/api/src/lib/workflow-version.ts', { 'node:crypto': crypto, '@testmind/core/workflow': core, '../prisma.js': { prisma } });
  const encryption = loadTs('apps/api/src/lib/crypto.ts', { crypto, '../config/env.js': { secretKeyBuffer: crypto.randomBytes(32) } });
  const { artifactModules } = await import('./artifact-harness.mjs');
  const artifacts = artifactModules(prisma, scratch, encryption);
  const controls = loadTs('apps/api/src/runner/workflow-controls.ts', { '@testmind/core/workflow': core });
  const engine = loadTs('apps/api/src/runner/workflow-engine.ts', { '@testmind/core/workflow': core, './workflow-controls.js': controls });
  let executeHandler = async () => { throw new Error('Unexpected external adapter in isolated integration'); };
  const runner = loadTs('apps/api/src/runner/workflow-runner.ts', { '@testmind/core/workflow': core, '../prisma.js': { prisma }, '../lib/crypto.js': encryption, '../lib/workflow-version.js': version, './workflow-engine.js': engine, './workflow-handlers.js': { executeWorkflowHandler: context => executeHandler(context) } });
  const graphRoutes = loadTs('apps/api/src/routes/workflowGraphs.ts', { '../lib/artifact-references.js': loadTs('apps/api/src/lib/artifact-references.ts'), '../lib/artifact-service.js': artifacts.service, '@clerk/fastify': { getAuth: req => ({ userId: req.headers['x-user-id'] }) }, '@testmind/core/workflow': core, '../prisma.js': { prisma }, '../lib/crypto.js': encryption, '../lib/workflow-version.js': version, '../runner/queue.js': { operatorQueue: queue, enqueueOperatorJob }, 'node:fs/promises': fs.promises, '../lib/storageRoots.js': { REPORT_ROOT: scratch } });
  const routes = loadTs('apps/api/src/routes/workflows.ts', { '@clerk/fastify': { getAuth: req => ({ userId: req.headers['x-user-id'] }) }, zod: require('zod'), '../prisma.js': { prisma }, '../runner/queue.js': { enqueueOperatorJob }, '../lib/git-url.js': loadTs('apps/api/src/lib/git-url.ts'), '../lib/workflow-version.js': version, './workflowGraphs.js': graphRoutes, '@testmind/core/workflow': core });
  app = require('fastify')(); await app.register(routes.default); await app.register(artifacts.routes.artifactRoutes, { roots: [path.join(scratch, 'runner-logs')] }); await app.ready();
  const call = async (method, url, payload, user = 'fixture-owner') => {
    const response = await app.inject({ method, url, payload, headers: { 'x-user-id': user } });
    if (response.statusCode >= 500) throw new Error(`Unexpected API failure ${response.statusCode}: ${response.body}`);
    return { status: response.statusCode, data: response.body ? response.json() : null };
  };
  const graph = { schemaVersion: 1, autonomy: 'assisted', variables: {}, limits: { maxDurationMs: 60000, maxNodeExecutions: 30, maxConcurrency: 1 }, nodes: [
    { id: 'start', type: 'start', version: 1, required: true, config: {}, inputs: {}, position: { x: 0, y: 0 } },
    { id: 'check', type: 'assert', version: 1, required: true, config: { checks: [{ id: 'status', operator: 'equals', expected: 200 }] }, inputs: { actual: { kind: 'constant', value: 200 } }, position: { x: 270, y: 20 } },
    { id: 'end', type: 'end', version: 1, required: true, config: {}, inputs: {}, position: { x: 540, y: 0 } },
  ], edges: [{ id: 'a', source: 'start', target: 'check', branch: 'success' }, { id: 'b', source: 'check', target: 'end', branch: 'success' }] };
  const createdWorkflow = await call('POST', '/workflows', { projectId: 'fixture-project', name: 'Graph fixture', workflowType: 'graph', graph });
  assert.equal(createdWorkflow.status, 201); const workflowId = createdWorkflow.data.workflow.id;
  assert.equal((await call('GET', `/workflows/${workflowId}/versions`, undefined, 'other-user')).status, 404);
  assert.equal(await prisma.workflowVersion.count({ where: { workflowId } }), 1);
  assert.equal((await prisma.workflow.findUnique({ where: { id: workflowId } })).configJson.graph.nodes[1].position.x, 270);
  const harness = createOperatorHarness();
  const workerDependencies = { ...harness.dependencies, bullmq, '../prisma.js': { prisma }, './redis.js': { redis }, './queue.js': { enqueueOperatorJob }, './workflow-runner.js': runner };
  const startWorker = () => loadTs('apps/api/src/runner/operator-worker.ts', workerDependencies).operatorWorker;
  worker = startWorker();
  const started = await call('POST', `/workflows/${workflowId}/run`); assert.equal(started.status, 202); const runId = started.data.run.id;
  await waitFor(async () => await prisma.operatorTask.count({ where: { workflowRunId: runId } }) >= 1, 'First node did not execute');
  await worker.close(); worker = startWorker();
  await waitFor(async () => (await prisma.workflowRun.findUnique({ where: { id: runId } })).status === 'succeeded', 'Restarted workflow did not finish');
  const tasks = await prisma.operatorTask.findMany({ where: { workflowRunId: runId } });
  assert.equal(tasks.length, 3); assert.equal(new Set(tasks.map(task => task.nodeKey)).size, 3);
  assert.ok(tasks.every(task => task.stateEncrypted && !task.stateEncrypted.includes('phase')));
  const inspection = await call('GET', `/workflows/runs/${runId}`); assert.ok(inspection.data.tasks.every(task => !('stateEncrypted' in task)));
  console.log('PASS: real API saves graph/version; real BullMQ worker resumes after restart without duplicate nodes; private state stays encrypted');
  const failedGraph = structuredClone(graph); failedGraph.nodes[1].inputs.actual.value = 500;
  assert.equal((await call('PATCH', `/workflows/${workflowId}`, { graph: failedGraph })).status, 200);
  const failedRun = (await call('POST', `/workflows/${workflowId}/run`)).data.run;
  await waitFor(async () => (await prisma.workflowRun.findUnique({ where: { id: failedRun.id } })).status === 'failed', 'Failed assertion did not fail workflow');
  assert.equal(await prisma.workflowVersion.count({ where: { workflowId } }), 2);
  assert.equal((await prisma.workflowRun.findUnique({ where: { id: runId } })).status, 'succeeded');
  console.log('PASS: assertion failure rejects workflow success; old version/run remains unchanged');
  await prisma.environment.create({ data: { id: 'protected-env', projectId: 'fixture-project', name: 'Protected fixture', baseUrl: 'https://example.test', isProtected: true, requiresApproval: true } });
  await call('PATCH', `/workflows/${workflowId}`, { graph, environmentId: 'protected-env' });
  const awaiting = (await call('POST', `/workflows/${workflowId}/run`)).data.run;
  assert.equal(awaiting.status, 'awaiting_approval'); assert.equal(awaiting.operatorJobId, null);
  await call('PATCH', `/workflows/${workflowId}`, { graph: failedGraph });
  const approvals = await Promise.all([call('POST', `/workflows/runs/${awaiting.id}/approve`), call('POST', `/workflows/runs/${awaiting.id}/approve`)]);
  assert.deepEqual(approvals.map(result => result.status).sort(), [200, 409]);
  await waitFor(async () => (await prisma.workflowRun.findUnique({ where: { id: awaiting.id } })).status === 'succeeded', 'Approved pinned version did not execute');
  console.log('PASS: protected environment waits for approval; approval pins the requested version and racing approvals dispatch once');
  const diagnostic = await call('POST', `/workflows/${workflowId}/run`, { debugNodeId: 'check' });
  await call('POST', `/workflows/runs/${diagnostic.data.run.id}/approve`);
  await waitFor(async () => (await prisma.workflowRun.findUnique({ where: { id: diagnostic.data.run.id } })).status === 'failed', 'Failed diagnostic must fail');
  assert.equal((await call('DELETE', `/workflows/${workflowId}`)).status, 204);
  assert.ok((await prisma.workflow.findUnique({ where: { id: workflowId } })).archivedAt);
  assert.ok(await prisma.workflowRun.count({ where: { workflowId } }) >= 4);
  assert.equal((await prisma.workflowRun.findUnique({ where: { id: 'legacy-run' } })).status, 'succeeded');
  console.log('PASS: archive retains versions and history; diagnostics retain failed evidence; legacy history remains intact');
  if (process.argv.includes('--acceptance')) {
    const { acceptanceScenarios } = await import('./acceptance-scenarios.mjs');
    await acceptanceScenarios({ root, scratch, prisma, queue, redis, bullmq, app, call, graph, core, encryption, version, runner, waitFor, loadTs, enqueueOperatorJob,
      setHandler: handler => { executeHandler = handler; }, setDispatchFault: fault => { dispatchFault = fault; },
      stopWorker: async () => { await worker.close(); }, startWorker: () => { worker = startWorker(); return worker; } });
  }
  }
} finally {
  await worker?.close(); await app?.close(); await queue?.close(); await redis?.quit(); await prisma?.$disconnect();
  for (const name of created.reverse()) {
    const label = docker(['inspect', '--format', '{{index .Config.Labels "testmind.workflow.test"}}', name]).trim();
    if (label === tag) docker(['stop', '--time', '3', name]);
  }
}
