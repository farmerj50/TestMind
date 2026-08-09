/**
 * AutonomousOrchestrator — public boundary for the autonomous QA pipeline.
 *
 * Phase 1: The orchestration logic lives inside operator-worker.ts as
 * `runAutonomousQaJob()` alongside the existing job dispatch. Per the
 * non-regression guardrails, extraction into a standalone class happens
 * only after the autonomous workflow passes regression testing.
 *
 * This file documents the intended interface and exposes the feature-flag
 * check so callers outside the worker can query availability without
 * importing operator-worker.ts directly.
 */

import { validatedEnv } from '../config/env.js';

export type AutonomousJobContext = {
  projectId: string;
  baseUrl: string;
  enableGitHubWriteback?: boolean;
  maxPages?: number;
  adapterId?: string;
  environmentId?: string;
};

export type AutonomousJobResult = {
  status: 'succeeded' | 'failed' | 'needs_review';
  specDir?: string;
  specCount?: number;
  healedCount?: number;
  prUrl?: string;
  prNumber?: number;
};

/** Returns true when TM_AUTONOMOUS_QA_ENABLED=1 is set in env. */
export function autonomousQaEnabled(): boolean {
  return validatedEnv.TM_AUTONOMOUS_QA_ENABLED === true;
}

/**
 * AutonomousOrchestrator — Phase 1 stub.
 *
 * Jobs are enqueued via POST /operator/jobs with:
 *   { type: "qa", context: { autonomous: true, baseUrl, enableGitHubWriteback } }
 *
 * The operator-worker picks up the job and routes to runAutonomousQaJob()
 * when ctx.autonomous === true.
 *
 * Phase 2 will extract the state-machine stages here as private methods:
 *   discover()  → runDiscoveryJob
 *   runTests()  → enqueueRun + poll
 *   repair()    → sequential self-heal loop
 *   verify()    → spec-path check + targeted retest
 *   fullVerify()→ full-suite retest
 *   writeback() → github-writeback.ts (gated by enableGitHubWriteback)
 */
export class AutonomousOrchestrator {
  static enabled(): boolean {
    return autonomousQaEnabled();
  }
}
