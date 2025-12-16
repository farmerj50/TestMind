// apps/api/src/runner/queue.ts
import { Queue } from 'bullmq';
import { redis } from './redis';

// What the worker expects to receive:
export type RunPayload = {
  projectId: string;
  browser?: 'chromium' | 'firefox' | 'webkit' | 'all';
  tags?: { include?: string[]; exclude?: string[] };
  retries?: number;
  headed?: boolean;
  envName?: string;
  trace?: 'on' | 'off' | 'retain-on-failure' | 'on-first-retry';
  grep?: string;
  file?: string;
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
  totalFailed: number;
  testTitle?: string | null;
  headed?: boolean;
  baseUrl?: string;
};

export type SecurityScanPayload = {
  jobId: string;
  projectId: string;
  baseUrl: string;
  allowedHosts: string[];
  allowedPorts: number[];
  maxDurationMinutes: number;
  enableActive: boolean;
};

export const runQueue = new Queue('test-runs', { connection: redis });
export const healingQueue = new Queue('self-heal', { connection: redis });
export const securityQueue = new Queue('security-scan', { connection: redis });

// helper the route will call:
export async function enqueueRun(runId: string, payload: RunPayload) {
  return runQueue.add(
    'execute',
    { runId, payload },
    {
      removeOnComplete: true,
      removeOnFail: false,
      attempts: 3,
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
