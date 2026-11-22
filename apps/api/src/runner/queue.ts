// apps/api/src/runner/queue.ts
import { Queue } from 'bullmq';
import { createQueueRedisConnection } from './redis.js';

// What the worker expects to receive:
export type RunPayload = {
  workflowRunId?: string;
  projectId: string;
  adapterId?: string;
  mode?: "regular" | "ai";
  genDir?: string;
  browser?: 'chromium' | 'firefox' | 'webkit' | 'all';
  tags?: { include?: string[]; exclude?: string[] };
  retries?: number;
  headed?: boolean;
  livePreview?: boolean;
  envName?: string;
  trace?: 'on' | 'off' | 'retain-on-failure' | 'on-first-retry';
  grep?: string;
  file?: string;
  suiteId?: string;
  baseUrl?: string;
  localRepoRoot?: string;
  timeoutMs?: number;
};

export type SelfHealPayload = {
  runId: string;
  testResultId: string;
  testCaseId: string;
  attemptId: string;
  projectId: string;
  adapterId?: string;
  totalFailed: number;
  testTitle?: string | null;
  headed?: boolean;
  baseUrl?: string;
  skipAutoRerun?: boolean;
};

export type SecurityScanPayload = {
  jobId: string;
  projectId: string;
  baseUrl: string;
  allowedHosts: string[];
  allowedPorts: number[];
  maxDurationMinutes: number;
  enableActive: boolean;
  environment?: string;
  scanDepth?: "baseline" | "standard" | "deep";
  safeMode?: boolean;
  sourceMode?: "auto" | "url_only" | "code_assisted";
  sourceRoot?: string;
  authProfiles?: Array<Record<string, any>>;
  apiFixtures?: Array<Record<string, any>>;
  expectedControls?: string[];
  owaspCategories?: string[];
  complianceFrameworks?: string[];
  openSourceToolIds?: string[];
  apiSpecId?: string;
  authSessionId?: string;
  mobileConfigId?: string;
  // Set to true only by operator-worker.ts's autonomous approval flow, immediately after
  // confirming an OperatorApproval row has status "approved" for this scan. Every other
  // caller (security.ts, ci.ts, mobile.ts) omits this - security-worker.ts's defense-in-depth
  // backstop uses its absence to know a prod-active scan hasn't gone through human approval.
  approvalGranted?: boolean;
};

function createQueue<T = any>(name: string) {
  return new Queue<T>(name, { connection: createQueueRedisConnection(name) });
}

export const runQueue = createQueue('test-runs');
export const healingQueue = createQueue('self-heal');
export const securityQueue = createQueue<SecurityScanPayload>('security-scan');
export const allureQueue = createQueue('allure-generate');
export const operatorQueue = createQueue<OperatorJobPayload>('operator-jobs');

export type ScheduleTriggerPayload = { scheduleId: string; projectId: string };
export const scheduleQueue = createQueue<ScheduleTriggerPayload>('schedule-trigger');

export type SecurityResumeCtx = {
  baseUrl: string;
  allowedHosts: string[];
  allowedPorts: number[];
  maxDurationMinutes: number;
  enableActive: boolean;
  environment?: string;
  scanDepth?: "baseline" | "standard" | "deep";
  safeMode?: boolean;
  sourceMode?: "auto" | "url_only" | "code_assisted";
  sourceRoot?: string;
  authProfiles?: Array<Record<string, any>>;
  apiFixtures?: Array<Record<string, any>>;
  expectedControls?: string[];
  owaspCategories?: string[];
  complianceFrameworks?: string[];
  openSourceToolIds?: string[];
};

/** Checkpoint stored in BullMQ job data so a re-queued job can resume without re-running from scratch. */
export type ResumePhase =
  | { kind: 'workflow_graph' }
  | { kind: 'wait_run'; runId: string; taskId: string; deadline: number }
  | { kind: 'approval_security'; approvalId: string; taskId: string; deadline: number; securityCtx: SecurityResumeCtx }
  | { kind: 'wait_scan'; scanId: string; taskId: string; deadline: number }
  | { kind: 'wait_repairs'; remaining: string[]; taskMap: Record<string, string>; deadline: number }
  | { kind: 'autonomous_qa'; state: Record<string, any> }
  | { kind: 'dev_agent_iterate'; devAgentRunId: string };

export type OperatorJobPayload = {
  operatorJobId: string;
  resumePhase?: ResumePhase;
};

export async function enqueueOperatorJob(operatorJobId: string, options?: { durable?: boolean }) {
  return operatorQueue.add(
    'execute',
    { operatorJobId } satisfies OperatorJobPayload,
    {
      jobId: operatorJobId,
      removeOnComplete: options?.durable ? false : true,
      removeOnFail: false,
      attempts: options?.durable ? 1 : 2,
      backoff: { type: 'exponential', delay: 15_000 },
    }
  );
}

// helper the route will call:
export async function enqueueRun(runId: string, payload: RunPayload) {
  return runQueue.add(
    'execute',
    { runId, payload },
    {
      jobId: runId,
      removeOnComplete: payload.workflowRunId ? false : true,
      removeOnFail: false,
      attempts: payload.workflowRunId ? 1 : 3,
      backoff: { type: 'exponential', delay: 30_000 },
    }
  );
}

export async function enqueueSelfHeal(payload: SelfHealPayload) {
  return healingQueue.add('heal', payload, {
    removeOnComplete: true,
    removeOnFail: false,
  });
}

export async function enqueueSecurityScan(payload: SecurityScanPayload) {
  return securityQueue.add('scan', payload, {
    removeOnComplete: true,
    removeOnFail: false,
  });
}

export type AllureGeneratePayload = {
  runId: string;
  cwd: string;
  allureResultsDir: string;
  allureReportDir: string;
  timeoutMs: number;
  stdoutPath: string;
  stderrPath: string;
};

export async function enqueueAllureGenerate(payload: AllureGeneratePayload) {
  return allureQueue.add('generate', payload, {
    removeOnComplete: true,
    removeOnFail: false,
    attempts: 2,
    backoff: { type: 'exponential', delay: 15_000 },
  });
}

// ── API Testing queue (functional validation — separate from security scans) ──

export type ApiTestRunPayload = {
  workflowRunId?: string;
  runId: string;
  collectionId: string;
  projectId: string;
  testCaseIds?: string[]; // undefined = run all cases in collection
};

export const apiTestQueue = createQueue<ApiTestRunPayload>('api-tests');

export async function enqueueApiTestRun(payload: ApiTestRunPayload) {
  return apiTestQueue.add('api-test-run', payload, {
    jobId: payload.runId,
    removeOnComplete: payload.workflowRunId ? false : true,
    removeOnFail: false,
    attempts: 1,
  });
}

// ── Evaluation Engine queue (apps/eval-service RAG/LLM metrics) — Phase 1 ──

export type EvaluationRunPayload = {
  runId: string;
  projectId: string;
};

export const evaluationQueue = createQueue<EvaluationRunPayload>('evaluation-runs');

export async function enqueueEvaluationRun(payload: EvaluationRunPayload) {
  return evaluationQueue.add('evaluation-run', payload, {
    jobId: payload.runId,
    removeOnComplete: true,
    removeOnFail: false,
    attempts: 1,
  });
}
