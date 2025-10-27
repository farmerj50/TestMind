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
};

export const runQueue = new Queue('test-runs', { connection: redis });

// helper the route will call:
export async function enqueueRun(runId: string, payload: RunPayload) {
  return runQueue.add(
    'execute',
    { runId, payload },
    { removeOnComplete: true, removeOnFail: false }
  );
}
