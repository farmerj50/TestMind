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
    '../lib/repair-verification.js': loadTs('apps/api/src/lib/repair-verification.ts'),
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
    // Autonomous QE (B1) dependencies. These harness jobs carry no context.qe, so the real
    // qeContextOf keeps them on the legacy autonomous path; every QE side effect must stay unused.
    '../lib/safe-fetch.js': { validateUrl: async () => { throw new Error('Unexpected QE URL validation'); } },
    // B2 knowledge: identity merge on the legacy path (the harness crawl has no scans/APIs).
    '../lib/app-knowledge.js': {
      computeCrawlKnowledgeUpdate: store => ({ next: store, diff: { pagesObserved: [], newPages: [], accessChanges: [], authRequired: [], unreachable: [], redirected: [], apisObserved: [], newApis: [], missingApis: [], thirdPartyHosts: [] } }),
      refreshStoryEvidence: store => store,
      incrementalSeedRoutes: () => [],
      routeClaimsFromTitles: () => [],
    },
    // B6: code-fix proposals are opt-in per QE run; legacy jobs never start one.
    '../lib/qe-codefix.js': { isCodeFixConfig: () => false, eligibleForCodeFix: () => ({ eligible: false, reason: 'legacy' }), appCodeFixEnabled: () => false, APP_CODE_FIX_DISABLED_REASON: 'disabled' },
    '../lib/qe-codefix-store.js': { createCodeFixProposal: async () => { throw new Error('Unexpected code-fix proposal on a legacy autonomous job'); } },
    // B5: failure intelligence and its objective guard only run for QE runs.
    '../lib/failure-intel.js': Object.fromEntries(['classifyFailure', 'decideRepair', 'repairPreservesObjective']
      .map(name => [name, () => { throw new Error(`Unexpected QE failure-intel call ${name} on a legacy autonomous job`); }])),
    '../lib/investigator.js': { investigateFailure: () => { throw new Error('Unexpected QE investigation on a legacy autonomous job'); } },
    // B4: legacy autonomous jobs carry no credential reference and never generate QE suites.
    '../lib/qe-credentials.js': { isCredentialRef: () => false },
    '../testmind/pipeline/qe-codegen.js': { generateQeSuite: () => { throw new Error('Unexpected QE codegen on a legacy autonomous job'); } },
    // B3 planner: only reached by QE runs; legacy autonomous jobs must never call it.
    '../lib/qe-plan.js': Object.fromEntries(['buildQePlan', 'gateSuiteTests', 'grepInvertFor', 'testTitlesInSpec']
      .map(name => [name, () => { throw new Error(`Unexpected QE planner call ${name} on a legacy autonomous job`); }])),
    '../lib/app-knowledge-store.js': Object.fromEntries(['getProjectKnowledge', 'loadKnowledgeInputs', 'loadPlanInputs', 'recordUserStory', 'inspectRepository', 'resolveLocalRepository', 'recordDeclaredRoutes', 'recordFailureInvestigations', 'recordRepairOutcome']
      .map(name => [name, async () => { throw new Error(`Unexpected QE knowledge call ${name} on a legacy autonomous job`); }])),
    './qe-orchestrator.js': {
      qeContextOf: ctx => (ctx?.autonomous === true && ctx?.qe && typeof ctx.qe === 'object' && typeof ctx.qe.input === 'string' ? ctx.qe : null),
      QeStageError: class QeStageError extends Error { constructor(stage, outcome, message) { super(message); this.stage = stage; this.outcome = outcome; } },
      recoverQeRuns: async () => [],
      ...Object.fromEntries(['ensureStages', 'startStage', 'finishStage', 'stageOutcome', 'currentStageKey', 'saveCheckpoint', 'finalizeQeRun', 'recordQeArtifact']
        .map(name => [name, async () => { throw new Error(`Unexpected QE call ${name} on a legacy autonomous job`); }])),
    },
  };
  dependencies['../lib/storageRoots.js'].REPORT_ROOT = path.join(root, 'virtual-reports');
  dependencies['./queue.js'].operatorQueue = { getJob: async () => null, add: async () => {} };
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
