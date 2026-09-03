// apps/api/src/lib/coverage-report.ts
//
// Coverage + Stop Decision v1, Ticket CS.1: a pure aggregation over an already-computed
// ApplicationBrainSnapshot. No Prisma import (matching application-model.ts's/
// autonomous-planner.ts's discipline). Deliberately does NOT import autonomous-planner.ts or
// call rankWorkflowRisk - see the frozen contract: this item's coverageGapPercent is a plain
// (100 - coveragePercent) computed independently, never routed through Planner's frozen
// formula, so the two concepts stay architecturally separate and this report never doubles as
// a second, differently-labeled copy of Planner's score.
//
// No synthesized recommendation, verdict, saturation percentage, or multi-dimension taxonomy
// anywhere here - see the frozen contract's NOT INCLUDED list. openItems' two counts are raw,
// uninterpreted facts; nothing here decides whether they're "fine" or not.
import type { ApplicationBrainSnapshot, NotAttributableFinding, FindingValidationStatus } from "./application-brain-query.js";

export type SecurityFindingValidationStatusCounts = {
  confirmed: number;
  likely: number;
  suspected: number;
  inconclusive: number;
  not_exploitable: number;
  false_positive: number;
  not_applicable: number;
  /** validationStatus === null - a human hasn't triaged this finding yet. */
  untriaged: number;
};

export type WorkflowCoverageEntry = {
  key: string;
  name: string;
  /** AB.3's existing per-workflow number, unrenamed and not recomputed - null when the
   * workflow declares zero routeHints (nothing to divide by), matching AB.3's own convention. */
  coveragePercent: number | null;
  /** 100 - coveragePercent, computed independently of Autonomous Planner v1's frozen formula.
   * null in the same case coveragePercent is null. */
  coverageGapPercent: number | null;
  /** Raw count of qaFailures joined by routeHint membership - not points, matching AP.2's join
   * but not its weighting. Linked and inferred confidence count equally (1 each). */
  qaFailuresCount: number;
  /** Attributed findings only, joined by routeHint membership, bucketed by validationStatus. */
  securityFindingsByValidationStatus: SecurityFindingValidationStatusCounts;
};

export type CoverageReport = {
  workflows: WorkflowCoverageEntry[];
  /** Passthrough of the Brain's own notAttributable list - never blended into any workflow's
   * counts, since these findings cannot be joined to a routeHint at all. */
  notAttributableFindings: NotAttributableFinding[];
  /** Raw, uninterpreted counts. No verdict, no threshold, no recommendation is computed from
   * these anywhere - the human reads the numbers and decides. */
  openItems: {
    untriagedFindingsCount: number;
    unresolvedQaFailuresCount: number;
  };
};

function emptyValidationStatusCounts(): SecurityFindingValidationStatusCounts {
  return {
    confirmed: 0,
    likely: 0,
    suspected: 0,
    inconclusive: 0,
    not_exploitable: 0,
    false_positive: 0,
    not_applicable: 0,
    untriaged: 0,
  };
}

function bucketKey(status: FindingValidationStatus): keyof SecurityFindingValidationStatusCounts {
  return status ?? "untriaged";
}

export function getWorkflowCoverageReport(snapshot: ApplicationBrainSnapshot): CoverageReport {
  const workflows: WorkflowCoverageEntry[] = snapshot.workflows.map((workflow) => {
    const routeHintSet = new Set(workflow.routeHints);

    const coveragePercent = workflow.coveragePercent;
    const coverageGapPercent = coveragePercent === null ? null : 100 - coveragePercent;

    const qaFailuresCount = snapshot.qaFailures.filter((failure) => routeHintSet.has(failure.routeHint)).length;

    const securityFindingsByValidationStatus = emptyValidationStatusCounts();
    for (const finding of snapshot.securityFindings.attributed) {
      if (!routeHintSet.has(finding.routeHint)) continue;
      securityFindingsByValidationStatus[bucketKey(finding.validationStatus)] += 1;
    }

    return {
      key: workflow.key,
      name: workflow.name,
      coveragePercent,
      coverageGapPercent,
      qaFailuresCount,
      securityFindingsByValidationStatus,
    };
  });

  const allFindings = [...snapshot.securityFindings.attributed, ...snapshot.securityFindings.notAttributable];
  const untriagedFindingsCount = allFindings.filter((finding) => finding.validationStatus === null).length;
  const unresolvedQaFailuresCount = snapshot.qaFailures.filter((failure) => failure.lastHealedAt === null).length;

  return {
    workflows,
    notAttributableFindings: snapshot.securityFindings.notAttributable,
    openItems: { untriagedFindingsCount, unresolvedQaFailuresCount },
  };
}
