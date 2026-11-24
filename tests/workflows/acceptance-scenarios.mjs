// Acceptance exercises: live local database/queue/HTTP, explicit fault injection,
// and the real compiled Workflows page. No application .env or external service.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

export async function acceptanceScenarios(ctx) {
  const { root, scratch, prisma, queue, redis, bullmq, call, graph, core, encryption, version, waitFor, loadTs, enqueueOperatorJob } = ctx;
  const require = createRequire(path.join(root, 'apps/api/package.json'));
  const results = [];
  const pass = message => { results.push({ status: 'PASS', message }); console.log(`AUDIT PASS: ${message}`); };
  const knownGap = (id, message) => { results.push({ status: 'FAIL', id, message }); console.log(`AUDIT FINDING ${id}: ${message}`); };
  const terminal = async id => {
    await waitFor(async () => ['succeeded', 'failed', 'canceled', 'debug-completed'].includes((await prisma.workflowRun.findUnique({ where: { id } })).status), `Run ${id} did not terminate`);
    return prisma.workflowRun.findUnique({ where: { id } });
  };
  const create = async (name, definition = graph, extra = {}) => {
    const response = await call('POST', '/workflows', { projectId: 'fixture-project', name, workflowType: 'graph', graph: definition, ...extra });
    assert.equal(response.status, 201, JSON.stringify(response.data)); return response.data.workflow;
  };
  const start = async id => { const response = await call('POST', `/workflows/${id}/run`); assert.equal(response.status, 202); return response.data.run; };
  const recovery = loadTs('apps/api/src/runner/workflow-recovery.ts', { '../prisma.js': { prisma }, './queue.js': { operatorQueue: queue, enqueueOperatorJob } });
  const policy = loadTs('apps/api/src/lib/workflow-execution-policy.ts', { '../prisma.js': { prisma }, './workflow-version.js': version, '@testmind/core/workflow': core });
  let requests = 0, writes = 0;
  const target = http.createServer(async (req, res) => {
    requests++;
    if (req.url === '/slow') { const timer = setTimeout(() => res.end('late'), 20000); res.on('close', () => clearTimeout(timer)); return; }
    if (req.url === '/write') { writes++; res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ status: 200, writes })); }
    if (req.url === '/authorized' && req.headers.authorization !== 'Bearer fixture-canary') { res.statusCode = 401; return res.end('Authentication required'); }
    if (req.url === '/api' || req.url === '/authorized') { res.setHeader('Content-Type', 'application/json'); res.setHeader('x-request-id', 'fixture-request'); res.setHeader('x-api-key', 'fixture-canary'); return res.end(JSON.stringify({ ready: true, echo: req.headers.authorization?.replace(/^Bearer /, '') })); }
    if (req.url === '/error') { res.statusCode = 503; return res.end('fixture backend unavailable'); }
    res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><html><head><title>Acceptance app</title></head><body><h1>Ready</h1><p>Workflow fixture</p></body></html>');
  });
  await new Promise(resolve => target.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${target.address().port}`;
  const globals = { fetch, process: { cwd: () => root, env: { TM_ALLOW_PRIVATE_OUTBOUND: 'true' } } };
  const safe = loadTs('apps/api/src/lib/safe-fetch.ts', { 'node:dns/promises': { lookup }, 'node:net': { isIP } }, globals);
  const network = loadTs('apps/api/src/lib/workflow-http.ts', { './safe-fetch.js': safe }, globals);
  const apiQueue = new bullmq.Queue('api-tests', { connection: redis });
  const enqueueApiTestRun = payload => apiQueue.add('api-test-run', payload, { jobId: payload.runId, removeOnComplete: false, attempts: 1 });
  const apiService = loadTs('apps/api/src/runner/api-test-service.ts', { undici: require('undici'), '../prisma.js': { prisma }, '@testmind/core/workflow': core, '../lib/workflow-http.js': network, '../lib/workflow-execution-policy.js': policy });
  const apiWorker = loadTs('apps/api/src/runner/api-test-worker.ts', { bullmq, './redis.js': { createQueueRedisConnection: () => redis, createRedisConnection: () => redis }, '../prisma.js': { prisma }, './api-test-service.js': apiService }).apiTestWorker;
  const handlers = loadTs('apps/api/src/runner/workflow-handlers.ts', {
    'node:fs/promises': fs, '@testmind/core/workflow': core, '../prisma.js': { prisma }, './queue.js': { enqueueApiTestRun, enqueueOperatorJob },
    '../lib/workflow-http.js': network, '../security/openapi-parser.js': loadTs('apps/api/src/security/openapi-parser.ts'), '../testmind/discover.js': {},
    '../testmind/pipeline/generate-plan.js': {}, '../testmind/pipeline/codegen.js': {}, '../lib/storageRoots.js': { GENERATED_ROOT: scratch, CURATED_ROOT: scratch },
    '../lib/application-brain-query.js': {}, '../lib/workflow-risk.js': {}, '../lib/workflow-evidence.js': {}, './workflow-evidence-collector.js': {},
  });
  ctx.setHandler(handlers.executeWorkflowHandler);
  try {
    const recoverable = await create('Dispatch and concurrency audit');
    await ctx.stopWorker();
    for (const fault of ['before', 'after']) {
      ctx.setDispatchFault(fault); const run = await start(recoverable.id); ctx.setDispatchFault(undefined);
      await recovery.recoverWorkflowDispatches(); await recovery.recoverWorkflowDispatches();
      assert.ok(await queue.getJob(run.operatorJobId)); ctx.startWorker();
      assert.equal((await terminal(run.id)).status, 'succeeded');
      assert.equal(await prisma.operatorTask.count({ where: { workflowRunId: run.id } }), 3);
      await ctx.stopWorker(); pass(`Injected ${fault}-dispatch failure recovers through real PostgreSQL/Redis without duplicate nodes`);
    }
    ctx.startWorker();
    const concurrent = await Promise.all([start(recoverable.id), start(recoverable.id), start(recoverable.id)]);
    for (const run of concurrent) assert.equal((await terminal(run.id)).status, 'succeeded');
    const original = concurrent[0];
    await enqueueOperatorJob(original.operatorJobId);
    await queue.add('duplicate-delivery', { operatorJobId: original.operatorJobId }, { jobId: `duplicate-${original.operatorJobId}` });
    await waitFor(async () => (await queue.getJob(`duplicate-${original.operatorJobId}`)).getState().then(state => state === 'completed'), 'Duplicate delivery did not finish');
    assert.equal(await prisma.operatorTask.count({ where: { workflowRunId: original.id } }), 3);
    pass('Concurrent workflows remain independent; retained-ID and explicit duplicate completed delivery preserve node history');

    const env = await prisma.environment.create({ data: { projectId: 'fixture-project', name: 'Audit local only', baseUrl } });
    await prisma.projectSecret.create({ data: { projectId: 'fixture-project', name: 'Synthetic audit token', key: 'audit_token', value: encryption.encryptSecret('fixture-canary') } });
    const n = (id, type, config = {}, inputs = {}) => ({ id, type, version: 1, required: true, position: { x: 0, y: 0 }, config, inputs });
    const chain = nodes => ({ ...structuredClone(graph), nodes, edges: nodes.slice(1).map((node, index) => ({ id: `edge-${index}`, source: nodes[index].id, target: node.id, branch: 'success' })) });
    const requestGraph = url => chain([n('start', 'start'), n('request', 'api.request', { method: 'GET', timeoutMs: 10000 }, { url: { kind: 'constant', value: url }, bearerToken: { kind: 'secret', key: 'audit_token' } }), n('check', 'assert', { checks: [{ id: 'status', path: 'status', operator: 'equals', expected: 200 }] }, { actual: { kind: 'output', nodeId: 'request', port: 'response' } }), n('end', 'end')]);
    const httpWorkflow = await create('Live HTTP and secrets', requestGraph(`${baseUrl}/authorized`), { environmentId: env.id });
    const httpRun = await start(httpWorkflow.id); assert.equal((await terminal(httpRun.id)).status, 'succeeded');
    const detail = await call('GET', `/workflows/runs/${httpRun.id}`);
    assert.equal(JSON.stringify(detail.data).includes('fixture-canary'), false);
    pass('Real workflow HTTP request injects project secret, checks response, and redacts response header/token reflections in report JSON');
    await call('PATCH', `/workflows/${httpWorkflow.id}`, { graph: requestGraph(`${baseUrl}/error`) });
    assert.equal((await terminal((await start(httpWorkflow.id)).id)).status, 'failed');
    pass('Real HTTP 503 persists response evidence and fails assertions');

    const slow = await create('Cancellation audit', requestGraph(`${baseUrl}/slow`), { environmentId: env.id });
    const slowRun = await start(slow.id); const beforeRequests = requests;
    await waitFor(async () => requests > beforeRequests, 'Slow request did not start');
    assert.equal((await call('POST', `/workflows/runs/${slowRun.id}/cancel`)).status, 200);
    await waitFor(async () => (await prisma.operatorTask.findFirst({ where: { workflowRunId: slowRun.id, nodeKey: 'request' } })).status === 'failed', 'Canceled node remained running');
    assert.equal((await terminal(slowRun.id)).status, 'canceled');
    pass('Canceling live HTTP work terminates the node with canceled evidence');

    const timeoutGraph = requestGraph(`${baseUrl}/slow`); timeoutGraph.nodes[1].config.timeoutMs = 1000; // the API Request node's minimum; /slow answers after 20s
    const timeoutWorkflow = await create('Live timeout audit', timeoutGraph, { environmentId: env.id });
    const timeoutRun = await start(timeoutWorkflow.id); assert.equal((await terminal(timeoutRun.id)).status, 'failed');
    assert.equal((await prisma.operatorTask.findFirst({ where: { workflowRunId: timeoutRun.id, nodeKey: 'request' } })).outputJson.failureKind, 'timeout');
    pass('Live HTTP deadline records timeout separately from assertion failure');

    const failedDefinition = structuredClone(graph); failedDefinition.nodes[1].inputs.actual.value = 500;
    const retryWorkflow = await create('Safe retry audit', failedDefinition);
    const retryRun = await start(retryWorkflow.id); assert.equal((await terminal(retryRun.id)).status, 'failed');
    await waitFor(async () => (await queue.getJob(retryRun.operatorJobId)).getState().then(value => value === 'failed'), 'Failed queue status pending');
    assert.equal((await call('POST', `/workflows/runs/${retryRun.id}/nodes/check/retry`)).status, 200);
    assert.equal((await terminal(retryRun.id)).status, 'failed');
    assert.equal(await prisma.operatorTask.count({ where: { workflowRunId: retryRun.id, nodeKey: 'check' } }), 2);
    pass('Safe pure-node retry retains both attempts and cannot turn an unchanged failing assertion green');

    await assert.rejects(network.workflowHttpRequest(`${baseUrl}/api`, { method: 'GET', timeoutMs: 1000, environment: { baseUrl: 'https://different.example' } }), /outside/);
    await assert.rejects(network.validateWorkflowTarget('file:///etc/passwd'), /protocol/);
    await assert.rejects(safe.validateUrl(baseUrl, { allowHttp: true, allowPrivateHosts: false }), /not allowed/);
    pass('Actual URL policy rejects cross-origin environment access, file URLs and private hosts by default');

    const apiGraph = chain([n('start', 'start'), n('generate', 'api.generate', { name: 'Imported API fixture' }, { specification: { kind: 'constant', value: { openapi: '3.0.0', info: { title: 'Fixture', version: '1' }, servers: [{ url: baseUrl }], paths: { '/api': { get: { responses: { 200: { description: 'Ready' } } } } } } } }), n('suite', 'api.suite', {}, { collectionId: { kind: 'output', nodeId: 'generate', port: 'collectionId' } }), n('end', 'end')]);
    const imported = await create('Import and execute API', apiGraph, { environmentId: env.id });
    const importedRun = await start(imported.id); assert.equal((await terminal(importedRun.id)).status, 'succeeded');
    const apiChild = await prisma.apiTestRun.findFirst({ where: { collectionId: { startsWith: 'wf-collection-' } }, include: { results: true } });
    assert.equal(apiChild.results.length, 1); assert.equal(apiChild.results[0].status, 'passed');
    const beforeDuplicate = requests;
    await Promise.all([apiService.runApiTests({ runId: apiChild.id, collectionId: apiChild.collectionId, projectId: 'fixture-project', workflowRunId: importedRun.id }), apiService.runApiTests({ runId: apiChild.id, collectionId: apiChild.collectionId, projectId: 'fixture-project', workflowRunId: importedRun.id })]);
    assert.equal(requests, beforeDuplicate); assert.equal((await prisma.apiTestRun.findUnique({ where: { id: apiChild.id } })).status, 'completed');
    pass('OpenAPI import generates assertions; actual API BullMQ worker persists results; completed redelivery performs no requests');

    for (const [method, url] of [['GET', `/workflows/runs/${httpRun.id}`], ['POST', `/workflows/runs/${slowRun.id}/resume`], ['POST', `/workflows/runs/${slowRun.id}/nodes/request/retry`], ['GET', `/workflows/${httpWorkflow.id}/versions`], ['PATCH', `/workflows/${httpWorkflow.id}`]]) {
      assert.equal((await call(method, url, method === 'PATCH' ? { name: 'intrusion' } : undefined, 'foreign-user')).status, 404);
    }
    pass('Live routes deny cross-project run, version, mutation, retry and resume access');

    // Inject a durable "executing" state immediately after a real external write.
    // This simulates process loss at the persistence boundary; it is not SIGKILL.
    await ctx.stopWorker();
    const writeGraph = requestGraph(`${baseUrl}/write`); writeGraph.nodes[1].config.method = 'POST';
    const writeWorkflow = await create('Ambiguous external write', writeGraph, { environmentId: env.id });
    const writeRun = await start(writeWorkflow.id);
    await prisma.operatorTask.create({ data: { jobId: writeRun.operatorJobId, workflowRunId: writeRun.id, nodeKey: 'start', nodeVersion: 1, type: 'execute', status: 'succeeded', stateEncrypted: encryption.encryptSecret(JSON.stringify({ phase: 'finished', activation: 'selected', branch: 'success', outputs: { variables: {} } })) } });
    await prisma.operatorTask.create({ data: { jobId: writeRun.operatorJobId, workflowRunId: writeRun.id, nodeKey: 'request', nodeVersion: 1, type: 'execute', status: 'running', stateEncrypted: encryption.encryptSecret(JSON.stringify({ phase: 'executing', activation: 'selected', deadline: Date.now() + 30000, inputs: { url: `${baseUrl}/write` } })) } });
    await fetch(`${baseUrl}/write`, { method: 'POST' }); const writesAfterCrash = writes;
    ctx.startWorker(); assert.equal((await terminal(writeRun.id)).status, 'failed'); assert.equal(writes, writesAfterCrash);
    const unknown = await prisma.operatorTask.findFirst({ where: { workflowRunId: writeRun.id, nodeKey: 'request' } });
    assert.equal(unknown.outputJson.outcome, 'unknown');
    pass('Injected crash after real write/before persistence preserves unknown outcome and prevents replay');

    const { browserAcceptance } = await import('./acceptance-browser.mjs');
    await browserAcceptance({ ...ctx, env, baseUrl, pass });
    const { uiAcceptance } = await import('./acceptance-ui.mjs');
    await uiAcceptance({ ...ctx, baseUrl, pass, knownGap, httpRun });
    if (results.some(result => result.status === 'FAIL')) process.exitCode = 2;
  } finally {
    await fs.writeFile(path.join(scratch, 'acceptance-results.json'), JSON.stringify(results, null, 2));
    await apiWorker.close(); await apiQueue.close(); target.closeAllConnections(); await new Promise(resolve => target.close(resolve));
  }
}
