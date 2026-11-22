import path from 'node:path';
import fs from 'node:fs/promises';
import { assessTestEvidence, allowsAutomaticRecovery } from '@testmind/core/workflow';
import { prisma } from '../prisma.js';
import { enqueueApiTestRun, enqueueRun, enqueueOperatorJob, enqueueEvaluationRun } from './queue.js';
import { workflowHttpRequest, validateWorkflowTarget } from '../lib/workflow-http.js';
import { parseApiSpec } from '../security/openapi-parser.js';
import { discoverSite, buildLocatorStoreFromScans } from '../testmind/discover.js';
import { generatePlan } from '../testmind/pipeline/generate-plan.js';
import { writeSpecsFromPlan } from '../testmind/pipeline/codegen.js';
import { GENERATED_ROOT, CURATED_ROOT } from '../lib/storageRoots.js';
import { getApplicationBrainSnapshot } from '../lib/application-brain-query.js';
import { selectWorkflowRisk } from '../lib/workflow-risk.js';
import { analyzeWorkflowEvidence } from '../lib/workflow-evidence.js';
import { collectWorkflowRunEvidence } from './workflow-evidence-collector.js';

export async function confinedPath(root: string, candidate: string) {
  const [realRoot, realCandidate] = await Promise.all([fs.realpath(root), fs.realpath(candidate)]);
  const relative = path.relative(realRoot, realCandidate);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Artifact path is outside its permitted root');
  return realCandidate;
}
function normalizeEvidence(status: string, rows: any[], requiredCaseIds: string[] = []) {
  const counts = { total: rows.length, passed: 0, failed: 0, errors: 0, skipped: 0 };
  for (const row of rows) if (row.status === 'passed') counts.passed++; else if (row.status === 'failed') counts.failed++; else if (row.status === 'skipped') counts.skipped++; else counts.errors++;
  const assertions = rows.flatMap(row => Array.isArray(row.assertionResults) ? row.assertionResults.map((a: any, index: number) => ({ id: `${row.id}-${index}`, status: a.passed ? 'passed' : 'failed' })) : []);
  return { status, counts, requiredCaseIds, passedCaseIds: rows.filter(r => r.status === 'passed').map(r => r.testCaseId), assertions };
}
// eval.run has no per-case TestEvidence-style rows (the eval-service gates on aggregate
// metrics across cases, not per-case pass/fail), so the whole EvaluationRun is treated as one
// composite evidence item - its own overallGateStatus drives passed/failed/skipped, never
// silently defaulting to "passed" for a skipped_no_data run.
function normalizeEvalEvidence(run: any) {
  const counts = { total: 1, passed: 0, failed: 0, errors: 0, skipped: 0 };
  let skippedIds: string[] = []; let expectedSkippedIds: string[] = [];
  if (run.overallGateStatus === 'pass') counts.passed = 1;
  else if (run.overallGateStatus === 'skipped_no_data') { counts.skipped = 1; skippedIds = [run.id]; expectedSkippedIds = [run.id]; }
  else counts.failed = 1;
  return { status: run.status, counts, skippedIds, expectedSkippedIds };
}
const completed = (outputs: any, extra: any = {}) => ({ outputs, branch: 'success', ...extra });
const testResult = (runId: string, evidence: any, source: string) => {
  const gate = assessTestEvidence(evidence); const outcome = gate.passed ? 'passed' : 'failed';
  return completed({ result: { outcome, runId, source, evidence, qualityGate: gate } }, { evidence, outcome, branch: gate.passed ? 'success' : 'failure' });
};

export async function executeWorkflowHandler(context: any): Promise<any> {
  const { node, inputs, task, checkpoint, run, snapshot, environment, graph, signal } = context;
  const projectId = run.workflow.projectId;
  const remaining = () => Math.max(1, task.state.deadline - Date.now());
  switch (node.type) {
    case 'python.script': {
      const { executePythonWorkflowNode } = await import('./python-node.js');
      return executePythonWorkflowNode(context);
    }
    case 'api.request': {
      const headers = { ...(inputs.headers ?? {}), ...(inputs.bearerToken ? { Authorization: `Bearer ${inputs.bearerToken}` } : {}) };
      if (Object.values(headers).some(value => typeof value !== 'string')) throw new Error('HTTP headers must be strings');
      return completed({ response: await workflowHttpRequest(inputs.url, { method: node.config.method, headers, body: inputs.body, timeoutMs: Math.min(node.config.timeoutMs ?? 30000, remaining()), environment, signal }) });
    }
    case 'api.generate': {
      const spec = parseApiSpec(inputs.specification);
      if (!spec.endpoints.length || spec.endpoints.length > 500) throw new Error('API specification must contain 1–500 supported endpoints');
      const baseUrl = environment?.baseUrl || spec.baseUrl;
      if (!baseUrl) throw new Error('Specify an API server URL or environment');
      await validateWorkflowTarget(baseUrl, environment);
      const collection = await prisma.apiCollection.create({ data: { id: `wf-collection-${task.id}`, projectId, name: node.config.name, baseUrl,
        environmentId: environment?.id, testCases: { create: spec.endpoints.map((ep, order) => {
          const operation = inputs.specification.paths?.[ep.path]?.[ep.method.toLowerCase()];
          const successes = Object.keys(operation?.responses ?? {}).map(Number).filter(code => code >= 200 && code < 300).sort();
          if (!successes.length) throw new Error(`Endpoint ${ep.method} ${ep.path} needs an explicit success response before test generation`);
          const status = successes[0];
          return { name: ep.summary ?? ep.operationId ?? `${ep.method} ${ep.path}`, method: ep.method, path: ep.path, expectedStatus: status,
            assertions: [{ type: 'status_equals', value: status }], order };
        }) } } });
      return completed({ collectionId: collection.id });
    }
    case 'api.suite': {
      const collection = await prisma.apiCollection.findFirst({ where: { id: inputs.collectionId, projectId }, include: { environment: true, testCases: true } });
      if (!collection) throw new Error('API collection not found in this project');
      if (collection.environmentId && collection.environmentId !== environment?.id) throw new Error('Select the API collection environment on this workflow');
      await validateWorkflowTarget(collection.baseUrl, environment);
      const childId = task.state.checkpoint?.childId ?? `wf-api-${task.id}`;
      const requiredCaseIds = task.state.checkpoint?.requiredCaseIds ?? collection.testCases.map(tc => tc.id);
      if (!task.state.checkpoint) await checkpoint({ childId, requiredCaseIds });
      await prisma.apiTestRun.upsert({ where: { id: childId }, create: { id: childId, projectId, collectionId: collection.id }, update: {} });
      const child = await prisma.apiTestRun.findUniqueOrThrow({ where: { id: childId }, include: { results: true } });
      if (child.status === 'queued') await enqueueApiTestRun({ runId: childId, collectionId: collection.id, projectId, workflowRunId: run.id, testCaseIds: requiredCaseIds });
      if (['queued', 'running'].includes(child.status)) return { pending: true };
      return testResult(childId, normalizeEvidence(child.status, child.results, requiredCaseIds), 'api');
    }
    case 'eval.run': {
      let cases = inputs.cases;
      if (inputs.datasetVersionId) {
        const version = await prisma.evaluationDatasetVersion.findFirst({
          where: { id: inputs.datasetVersionId, dataset: { projectId } },
        });
        if (!version) throw new Error('Evaluation dataset version not found in this project');
        cases = version.casesJson;
      }
      if (!cases) throw new Error('eval.run requires either "cases" or "datasetVersionId"');

      const childId = task.state.checkpoint?.childId ?? `wf-eval-${task.id}`;
      if (!task.state.checkpoint) await checkpoint({ childId });
      await prisma.evaluationRun.upsert({
        where: { id: childId },
        create: {
          id: childId, projectId,
          datasetId: inputs.datasetId, datasetVersion: inputs.datasetVersion,
          applicationId: inputs.applicationId, applicationVersion: inputs.applicationVersion,
          gatesConfig: inputs.gates ?? undefined, casesJson: cases,
        },
        update: {},
      });
      const child = await prisma.evaluationRun.findUniqueOrThrow({ where: { id: childId } });
      if (child.status === 'queued') await enqueueEvaluationRun({ runId: childId, projectId });
      if (['queued', 'running'].includes(child.status)) return { pending: true };
      return testResult(childId, normalizeEvalEvidence(child), 'eval');
    }
    case 'ui.discover': {
      await validateWorkflowTarget(inputs.baseUrl, environment);
      const discovery = await discoverSite(inputs.baseUrl, [], { maxPages: node.config.maxPages, signal: signal ?? AbortSignal.timeout(remaining()),
        validateRequest: async url => { await validateWorkflowTarget(url, environment ?? { baseUrl: inputs.baseUrl }); } });
      return completed({ discovery: { ...discovery, baseUrl: inputs.baseUrl } });
    }
    case 'ui.generate': {
      const discovery = inputs.discovery;
      if (!discovery || !Array.isArray(discovery.scans) || !discovery.scans.length || discovery.scans.length > 100) throw new Error('UI generation requires bounded discovery scans');
      await validateWorkflowTarget(discovery.baseUrl, environment);
      const selectedRoutes: string[] | undefined = inputs.riskPlan?.routeHints;
      const scans = selectedRoutes ? discovery.scans.filter((scan: any) => selectedRoutes.includes(new URL(scan.url).pathname)) : discovery.scans;
      if (!scans.length) throw new Error('No discovered routes match the selected risk plan');
      for (const scan of scans) await validateWorkflowTarget(scan.url, environment ?? { baseUrl: discovery.baseUrl });
      const plan = generatePlan({ env: { baseUrl: discovery.baseUrl }, component: { id: projectId, type: 'UI' }, requirement: { id: 'workflow', title: 'Workflow UI tests', priority: 'P2' }, risks: { likelihood: 0.3, impact: 0.5 }, discovered: { routes: scans.map((scan: any) => scan.url), forms: discovery.forms ?? [], scans } }, 'sdet');
      const maxTests = Math.min(node.config.maxTests, inputs.riskPlan?.maxTests ?? 500);
      plan.cases = (plan.cases ?? []).slice(0, maxTests);
      if (!plan.cases.length) throw new Error('Discovery produced no executable tests');
      const outDir = path.join(GENERATED_ROOT, `workflow-${projectId}`, run.id, task.id);
      await writeSpecsFromPlan(outDir, plan, 'playwright-ts', { locatorStore: buildLocatorStoreFromScans(scans), baseUrl: discovery.baseUrl });
      const artifact = await prisma.operatorArtifact.create({ data: { jobId: run.operatorJobId, taskId: task.id, type: 'report', path: outDir, metaJson: { kind: 'generated-suite', baseUrl: discovery.baseUrl, testCount: plan.cases.length } } });
      return completed({ suite: { id: artifact.id, artifactId: artifact.id, kind: 'generated' } });
    }
    case 'ui.suite': {
      let file: string, baseUrl = inputs.baseUrl ?? environment?.baseUrl ?? snapshot.configJson.baseUrl;
      if (inputs.suite.kind === 'curated') {
        const suite = await prisma.curatedSuite.findFirst({ where: { id: inputs.suite.id, projectId } });
        if (!suite) throw new Error('UI suite not found in this project');
        file = await confinedPath(CURATED_ROOT, path.resolve(CURATED_ROOT, suite.rootRel));
      } else {
        const artifact = await prisma.operatorArtifact.findFirst({ where: { id: inputs.suite.artifactId ?? inputs.suite.id, job: { projectId }, metaJson: { path: ['kind'], equals: 'generated-suite' } } });
        if (!artifact) throw new Error('Generated suite artifact not found in this project');
        file = await confinedPath(path.join(GENERATED_ROOT, `workflow-${projectId}`), artifact.path);
        baseUrl ??= (artifact.metaJson as any)?.baseUrl;
      }
      if (!baseUrl) throw new Error('UI suite requires a base URL or environment');
      await validateWorkflowTarget(baseUrl, environment);
      let grep: string | undefined;
      const requiredCaseIds: string[] = task.state.checkpoint?.requiredCaseIds ?? inputs.riskPlan?.selectedTestIds ?? [];
      if (inputs.riskPlan) {
        if (!requiredCaseIds.length) throw new Error('Risk plan selected no existing tests; generate gap tests first');
        const cases = await prisma.testCase.findMany({ where: { projectId, id: { in: requiredCaseIds }, status: { not: 'archived' } } });
        if (cases.length !== requiredCaseIds.length) throw new Error('Selected tests are no longer available');
        grep = cases.map(tc => tc.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
      }
      const childId = task.state.checkpoint?.childId ?? `wf-ui-${task.id}`;
      if (!task.state.checkpoint) await checkpoint({ childId, requiredCaseIds });
      await prisma.testRun.upsert({ where: { id: childId }, create: { id: childId, projectId, status: 'queued', trigger: 'workflow', environmentId: environment?.id, paramsJson: { mode: 'ai', baseUrl, file, disableAutoSelfHeal: true, workflowRunId: run.id } }, update: {} });
      await prisma.operatorTask.update({ where: { id: task.id }, data: { testRunId: childId } });
      const child = await prisma.testRun.findUniqueOrThrow({ where: { id: childId }, include: { results: true } });
      if (child.status === 'queued') await enqueueRun(childId, { projectId, file, baseUrl, mode: 'ai', grep, workflowRunId: run.id, timeoutMs: remaining(), trace: 'on' });
      if (['queued', 'running'].includes(child.status)) return { pending: true };
      return testResult(childId, normalizeEvidence(child.status, child.results, requiredCaseIds), 'ui');
    }
    case 'qa.autonomous': case 'legacy.action': {
      if (node.config.workflowType === 'repair' && !allowsAutomaticRecovery(graph.autonomy)) throw new Error('Automatic recovery is disabled at this autonomy level');
      const autonomous = node.type === 'qa.autonomous';
      const baseUrl = inputs.baseUrl ?? environment?.baseUrl ?? snapshot.configJson.baseUrl;
      if (baseUrl) await validateWorkflowTarget(baseUrl, environment);
      const childId = task.state.checkpoint?.childId ?? `wf-operator-${task.id}`;
      const type = autonomous || node.config.workflowType === 'qa-execute' ? 'qa' : node.config.workflowType;
      if (!task.state.checkpoint) await checkpoint({ childId });
      await prisma.operatorJob.upsert({ where: { id: childId }, create: { id: childId, projectId, type, requestedBy: run.requestedBy, environmentId: environment?.id,
        contextJson: { ...snapshot.configJson, graph: undefined, baseUrl, maxPages: node.config.maxPages, autonomous, autonomyLevel: graph.autonomy, suiteId: snapshot.suiteId,
          workflowParentId: run.id, generatedScope: childId, enableGitHubWriteback: false } }, update: {} });
      const child = await prisma.operatorJob.findUniqueOrThrow({ where: { id: childId }, include: { tasks: { orderBy: { createdAt: 'desc' } } } });
      if (child.status === 'queued') await enqueueOperatorJob(childId, { durable: true });
      if (['queued', 'running', 'blocked'].includes(child.status)) return { pending: true };
      const tested = child.tasks.find(task => task.testRunId);
      if (!tested?.testRunId) return completed({ result: { outcome: child.status === 'succeeded' ? 'unknown' : 'failed', operatorJobId: childId, explanation: 'This action produced no test verification evidence' } }, { outcome: 'unknown' });
      const results = await prisma.testResult.findMany({ where: { runId: tested.testRunId } });
      return testResult(tested.testRunId, normalizeEvidence(child.status, results), 'ui');
    }
    case 'risk.select': return completed({ plan: selectWorkflowRisk(await getApplicationBrainSnapshot(projectId), run.createdAt.toISOString(), node.config.maxWorkflows, node.config.maxTests) });
    case 'evidence.analyze': {
      const evidence = await collectWorkflowRunEvidence(projectId, inputs.result, run.operatorJobId, task.id);
      return completed({ analysis: analyzeWorkflowEvidence(evidence) });
    }
    default: throw new Error(`No execution adapter registered for ${node.type}`);
  }
}
