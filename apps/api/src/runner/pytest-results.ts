import { assessTestEvidence, type TestEvidence } from '@testmind/core/workflow';
import type { ParsedCase } from './result-parsers.js';

// Private runner data, not a downloadable report. Existing artifact authorization
// and sanitization must still be applied before exposing messages or test names.
export type PytestCase = ParsedCase & {
  id: string;
  phase?: 'collection' | 'setup' | 'call' | 'teardown';
  scriptResult?: { status: 'completed' | 'assertion' | 'error'; json?: string };
};

export type PytestOutcome =
  | 'passed' | 'assertion-failure' | 'collection-error' | 'execution-error'
  | 'timeout' | 'canceled' | 'no-tests' | 'invalid-report' | 'quality-gate-failure';

export interface PytestResultInput {
  cases: PytestCase[];
  exitCode: number | null;
  reportState: 'complete' | 'missing' | 'invalid';
  termination?: 'timeout' | 'canceled';
  requiredCaseIds?: string[];
  expectedSkippedIds?: string[];
  assertions?: TestEvidence['assertions'];
  verifications?: TestEvidence['verifications'];
}

/** Normalize parsed results without running Python, granting approvals, or exporting artifacts. */
export function normalizePytestResults(input: PytestResultInput) {
  const ids = new Set<string>();
  const validCases = Array.isArray(input.cases) && input.cases.length <= 10_000 && input.cases.every(item => {
    if (!item || typeof item.id !== 'string' || !item.id.trim() || ids.has(item.id)) return false;
    ids.add(item.id);
    return typeof item.file === 'string' && typeof item.fullName === 'string'
      && ['passed', 'failed', 'skipped', 'error'].includes(item.status)
      && (item.phase === undefined || ['collection', 'setup', 'call', 'teardown'].includes(item.phase))
      && (item.phase !== 'collection' || item.status === 'error')
      && (item.durationMs === undefined || (Number.isFinite(item.durationMs) && item.durationMs >= 0));
  });
  // Never use partial/malformed reports as passing evidence.
  const cases = input.reportState === 'complete' && validCases ? input.cases : [];
  const counts = { total: cases.length, passed: 0, failed: 0, errors: 0, skipped: 0 };
  for (const item of cases) counts[item.status === 'error' ? 'errors' : item.status]++;

  let outcome: PytestOutcome;
  if (input.termination === 'canceled') outcome = 'canceled';
  else if (input.termination === 'timeout') outcome = 'timeout';
  else if (input.reportState !== 'complete' || !validCases) outcome = 'invalid-report';
  else if (cases.some(item => item.phase === 'collection')) outcome = 'collection-error';
  else if (input.exitCode !== 0 && input.exitCode !== 1 && input.exitCode !== 5) outcome = 'execution-error';
  else if (!cases.length) outcome = input.exitCode === 1 ? 'execution-error' : 'no-tests';
  else if (input.exitCode === 5 || counts.errors > 0) outcome = 'execution-error';
  else if (counts.failed > 0) outcome = 'assertion-failure';
  else if (input.exitCode !== 0) outcome = 'execution-error';
  else outcome = 'passed';

  const evidence: TestEvidence = {
    status: outcome === 'passed' ? 'succeeded' : outcome === 'canceled' ? 'canceled' : 'failed',
    counts,
    passedCaseIds: cases.filter(item => item.status === 'passed').map(item => item.id),
    skippedIds: cases.filter(item => item.status === 'skipped').map(item => item.id),
    requiredCaseIds: input.requiredCaseIds,
    expectedSkippedIds: input.expectedSkippedIds,
    assertions: input.assertions,
    verifications: input.verifications,
  };
  const quality = assessTestEvidence(evidence);
  if (outcome === 'passed' && !quality.passed) {
    outcome = 'quality-gate-failure';
    evidence.status = 'failed';
  }
  return { outcome, cases, evidence, quality };
}
