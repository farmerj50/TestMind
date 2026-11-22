// Executes the real worker module with in-memory adapters. No application config,
// database, Redis, browser, filesystem writes, or external services are loaded.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as workflowContracts from '../../packages/testmind-core/workflow/index.js';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const root = fileURLToPath(new URL('../../', import.meta.url));

export function loadTs(relativePath, dependencies = {}, globals = {}) {
  const filename = path.join(root, relativePath);
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: filename,
  }).outputText;
  const exports = {};
  const context = vm.createContext({
    exports, module: { exports }, process: { cwd: () => root, env: {} },
    console: { log() {}, warn() {}, error() {} }, URL, Date, Buffer, AbortController, AbortSignal, setTimeout, clearTimeout, setInterval, clearInterval,
    require(name) {
      if (Object.hasOwn(dependencies, name)) return dependencies[name];
      if (name === 'path' || name === 'node:path') return path;
      throw new Error(`Unmocked dependency ${name} in ${relativePath}`);
    },
    ...globals,
  });
  new vm.Script(compiled, { filename }).runInContext(context);
  return context.module.exports;
}

export function createOperatorHarness({ enabled = true, type = 'qa', context = {} } = {}) {
  const generatedRoot = path.join(root, 'virtual-generated');
  const generatedDir = path.join(generatedRoot, 'playwright-ts-owner-1', 'project-1');
  const files = new Set([generatedDir, path.join(generatedDir, 'home.spec.ts'), root]);
  const tables = Object.fromEntries([
    'project', 'operatorJob', 'operatorTask', 'testRun', 'testResult', 'testCase',
    'testHealingAttempt', 'humanInterventionCandidate', 'operatorArtifact',
    'operatorDecision', 'operatorApproval', 'securityScanJob',
  ].map(name => [name, []]));
  const calls = { runs: [], heals: [], scans: [], discoveries: 0, generated: 0, moves: [] };
  let sequence = 0;
  const plain = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  const match = (row, where = {}) => Object.entries(where).every(([key, expected]) => {
    if (expected && typeof expected === 'object') {
      if ('not' in expected) return row[key] !== expected.not;
      if ('in' in expected) return expected.in.includes(row[key]);
      if (key === 'testCase') return match(tables.testCase.find(c => c.id === row.testCaseId) ?? {}, expected);
      if (key === 'projectId_key') return row.projectId === expected.projectId && row.key === expected.key;
      return match(row[key] ?? {}, expected);
    }
    return row[key] === expected;
  });
  const decorate = (row, include) => row && ({ ...plain(row), ...(include?.testCase ? {
    testCase: plain(tables.testCase.find(c => c.id === row.testCaseId)),
  } : {}) });
  const prisma = Object.fromEntries(Object.entries(tables).map(([name, rows]) => [name, {
    async create({ data }) {
      const row = { id: `${name}-${++sequence}`, status: 'queued', ...plain(data) };
      for (const [relation, idField] of [['run', 'runId'], ['testResult', 'testResultId'], ['testCase', 'testCaseId']]) {
        if (data[relation]?.connect) row[idField] = data[relation].connect.id;
      }
      rows.push(row);
      return plain(row);
    },
    async findUnique({ where, include }) { return decorate(rows.find(r => match(r, where)), include) ?? null; },
    async findFirst({ where, include }) { return decorate(rows.find(r => match(r, where)), include) ?? null; },
    async findMany({ where, include } = {}) { return rows.filter(r => match(r, where)).map(r => decorate(r, include)); },
    async update({ where, data }) {
      const row = rows.find(r => match(r, where));
      if (!row) throw new Error(`Missing ${name}: ${JSON.stringify(where)}`);
      Object.assign(row, plain(data));
      return plain(row);
    },
    async updateMany({ where, data }) {
      const matching = rows.filter(r => match(r, where));
      matching.forEach(r => Object.assign(r, plain(data)));
      return { count: matching.length };
    },
    async count({ where } = {}) { return rows.filter(r => match(r, where)).length; },
    async createMany({ data }) { rows.push(...plain(data)); return { count: data.length }; },
  }]));
  prisma.$transaction = fn => fn(prisma);
  tables.project.push({ id: 'project-1', ownerId: 'owner-1', repoUrl: 'https://app.example.test', sharedSteps: {} });
  tables.operatorJob.push({
    id: 'job-1', projectId: 'project-1', requestedBy: 'owner-1', type, status: 'queued',
    contextJson: { autonomous: true, baseUrl: 'https://app.example.test', ...context },
  });
  let processor;
  class DelayedError extends Error {}
  class Worker {
    constructor(_name, callback) { processor = callback; }
    on() {}
  }
  const securityPolicy = loadTs('apps/api/src/lib/security-approval-policy.ts');
  const decisions = loadTs('apps/api/src/lib/operator-decisions.ts', { '../prisma.js': { prisma } });
  const dependencies = {
    bullmq: { Worker, DelayedError },
    fs: { existsSync: p => files.has(path.resolve(p)), mkdirSync: p => files.add(path.resolve(p)) },
    'fs/promises': { readdir: async p => files.has(path.resolve(p)) ? [
      { name: 'home.spec.ts', isDirectory: () => false, isFile: () => true },
    ] : [] },
    '../prisma.js': { prisma }, './redis.js': { redis: {} },
    './queue.js': {
      enqueueRun: async (id, payload) => calls.runs.push({ id, ...plain(payload) }),
      enqueueSelfHeal: async payload => calls.heals.push(plain(payload)),
      enqueueSecurityScan: async payload => calls.scans.push(plain(payload)),
    },
    '../testmind/curated-store.js': { CURATED_ROOT: path.join(root, 'virtual-curated'), agentSuiteId: () => 'suite-1' },
    '../lib/storageRoots.js': { GENERATED_ROOT: generatedRoot },
    './step-executor.js': { createStepRunner: () => { throw new Error('Unexpected step execution'); } },
    './capabilities/browser-cap.js': {},
    '../testmind/discover.js': {
      discoverSite: async () => { calls.discoveries++; return { routes: ['/'], forms: [], scans: [] }; },
      buildLocatorStoreFromScans: () => ({ pages: {} }),
    },
    '../testmind/pipeline/generate-plan.js': { generatePlan: () => ({ cases: [] }) },
    '../testmind/pipeline/codegen.js': { writeSpecsFromPlan: async () => { calls.generated++; return { total: 1 }; } },
    '../lib/git-url.js': loadTs('apps/api/src/lib/git-url.ts'),
    '@testmind/core/framework': { DEFAULT_FRAMEWORK_ID: 'playwright-ts' },
    '@testmind/core/workflow': workflowContracts,
    '../lib/workflow-evidence.js': loadTs('apps/api/src/lib/workflow-evidence.ts'),
    './workflow-evidence-collector.js': { collectWorkflowRunEvidence: async (_project, result) => tables.testResult.filter(r => r.runId === result.runId).map(r => ({ id: r.id, kind: 'assertion', runId: r.runId, caseId: r.testCaseId, message: r.message, failureClass: r.status })) },
    '../lib/operator-decisions.js': decisions,
    '../lib/application-model.js': {
      normalizeApplicationModel: value => value ?? {}, normalizeRouteHint: value => value,
      computeApplicationModelUpdate: () => ({ next: {}, diff: { newPages: [], changedPages: [], unchangedPages: [], missingPages: [] } }),
      upsertTestLink: value => value,
    },
    '../lib/application-model-store.js': { applyApplicationModelMerge: async () => {} },
    './github-writeback.js': { getOctokitForProject: async () => null },
    '../config/env.js': { validatedEnv: { TM_AUTONOMOUS_QA_ENABLED: enabled } },
    '../lib/security-approval-policy.js': securityPolicy,
    '../security/open-source-tools.js': { normalizeOpenSourceToolIds: value => value ?? [] },
  };
  const job = {
    data: { operatorJobId: 'job-1' },
    async updateData(data) { this.data = plain(data); },
    async moveToDelayed(time) { calls.moves.push(time); },
  };
  const restart = () => loadTs('apps/api/src/runner/operator-worker.ts', dependencies);
  restart();
  return {
    tables, calls, prisma, job, generatedDir, restart, dependencies,
    get state() { return job.data.resumePhase?.state; },
    get status() { return tables.operatorJob[0].status; },
    async tick() {
      try { await processor(job, 'fixture-token'); return 'completed'; }
      catch (error) { if (error instanceof DelayedError) return 'delayed'; throw error; }
    },
    finishRun(status = 'succeeded', results = [{ status: 'passed' }]) {
      const run = tables.testRun.find(r => r.id === job.data.resumePhase.state.runId);
      run.status = status;
      tables.testResult.splice(0, tables.testResult.length, ...tables.testResult.filter(r => r.runId !== run.id));
      for (const [index, result] of results.entries()) {
        const testCaseId = result.testCaseId ?? `case-${index}`;
        if (!tables.testCase.some(c => c.id === testCaseId)) tables.testCase.push({ id: testCaseId, title: `test ${index}`, status: 'active' });
        tables.testResult.push({ id: `${run.id}-result-${index}`, runId: run.id, testCaseId, ...result });
      }
      return run.id;
    },
    finishRepair(status = 'succeeded') {
      Object.assign(tables.testHealingAttempt.find(a => a.id === job.data.resumePhase.state.attemptId), {
        status, targetSpec: path.join(generatedDir, 'home.spec.ts'),
      });
    },
  };
}
