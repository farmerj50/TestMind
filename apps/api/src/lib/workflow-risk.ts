import { rankWorkflowRisk } from './autonomous-planner.js';
import type { ApplicationBrainSnapshot } from './application-brain-query.js';

export function selectWorkflowRisk(snapshot: ApplicationBrainSnapshot, now: string, maxWorkflows: number, maxTests: number) {
  if (!Number.isInteger(maxWorkflows) || maxWorkflows < 1 || maxWorkflows > 100 || !Number.isInteger(maxTests) || maxTests < 1 || maxTests > 500) throw new Error('Invalid risk selection bounds');
  const ranked = rankWorkflowRisk(snapshot, now, { topN: maxWorkflows });
  const routes = [...new Set(ranked.ranked.flatMap(w => w.routeHints))];
  const selectedTestIds = [...new Set(routes.flatMap(route => snapshot.coverage.filter(c => c.routeHint === route).map(c => c.testCaseId)))].slice(0, maxTests);
  const gaps = routes.filter(route => !snapshot.coverage.some(c => c.routeHint === route));
  return { selected: ranked.ranked, unrankable: ranked.unrankable, selectedTestIds, routeHints: routes.slice(0, maxTests),
    proposedTests: gaps.slice(0, Math.max(0, maxTests - selectedTestIds.length)).map(route => ({ route, reason: 'No mapped test coverage', kind: 'ui' })),
    maxTests, asOf: now, scope: 'Bounded route-based selection; inferred coverage is retained with its original confidence.' };
}
