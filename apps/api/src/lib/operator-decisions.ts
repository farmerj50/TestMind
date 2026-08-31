// apps/api/src/lib/operator-decisions.ts
//
// Project Memory foundation, Phase 1: wires the OperatorDecision table (schema already
// has decisionType/rationale/confidence/model/evidenceJson - it existed unused before this).
//
// Scope discipline: this phase only derives decisions from classifyRunFailures's
// self-heal/blocked/defect output ('heal'/'escalate' decisionTypes). OperatorDecision is a
// general-purpose decision-evidence record - its long-term value is capturing other
// decision types too (patch/retry/request_approval, e.g. "a required field was added and no
// test exercises it", or "this action touches production data"). deriveDecisionForFailureClassification
// is named and typed narrowly for exactly what it does, so a future sibling deriver (e.g.
// deriveDecisionForApplicationModelChange) is obviously a new function, not a shoehorned
// extension of this one's signature. recordOperatorDecisions itself is already generic over
// decisionType/evidence so future decision-producing code reuses this same write path.
import { prisma } from "../prisma.js";

export type FailureClassification = {
  type: "self-heal" | "blocked" | "defect";
  testResultId: string;
  testCaseId: string;
  title: string;
  message: string | null;
};

export type OperatorDecisionTypeForFailure = "heal" | "escalate";

export type DecisionRecordInput = {
  decisionType: OperatorDecisionTypeForFailure;
  rationale: string;
  confidence: number;
  model: string | null;
  evidenceJson: Record<string, unknown>;
};

// Mirrors classifyRunFailures's keyword heuristics (operator-worker.ts) exactly, so the
// rationale can name which specific signal(s) fired. classifyRunFailures only returns the
// final bucket, not which keywords matched - kept in sync here rather than changing that
// function's return shape for this phase's more limited needs. If those heuristics change,
// update this list to match.
const AUTOMATION_SIGNALS = ["locator", "tobevisible", "element(s) not found", "waiting for", "selector", "strict mode violation"];
const INFRA_SIGNALS = ["timeout", "net::", "econnrefused", "navigation", "err_connection"];

function matchedSignals(message: string | null, signals: string[]): string[] {
  const lower = (message ?? "").toLowerCase();
  return signals.filter((s) => lower.includes(s));
}

export function deriveDecisionForFailureClassification(c: FailureClassification): DecisionRecordInput {
  const decisionType: OperatorDecisionTypeForFailure = c.type === "self-heal" ? "heal" : "escalate";
  const signals = c.type === "self-heal" ? matchedSignals(c.message, AUTOMATION_SIGNALS) : matchedSignals(c.message, INFRA_SIGNALS);

  const rationale =
    signals.length > 0
      ? `Classified "${c.title}" as ${c.type} - matched ${c.type === "self-heal" ? "automation-drift" : "infra/blocked"} signal(s): ${signals.join(", ")}`
      : `Classified "${c.title}" as ${c.type} - no automation-drift or infra keyword matched; treated as a likely defect`;

  // Simple, monotonic heuristic: more matched signals -> higher confidence. classifyRunFailures
  // is a regex/substring classifier today, not an LLM call, so this is a rule-based confidence,
  // not a model-reported one.
  const confidence = signals.length > 0 ? Math.min(0.95, 0.5 + signals.length * 0.15) : 0.3;

  return {
    decisionType,
    rationale,
    confidence,
    model: "rule:classifyRunFailures/keyword-heuristic",
    evidenceJson: {
      testResultId: c.testResultId,
      testCaseId: c.testCaseId,
      title: c.title,
      message: c.message,
      classification: c.type,
      matchedSignals: signals,
    },
  };
}

export function deriveDecisionsForFailureClassifications(cs: FailureClassification[]): DecisionRecordInput[] {
  return cs.map(deriveDecisionForFailureClassification);
}

/**
 * Thin I/O wrapper, deliberately fail-soft (catch + log, never throw) - this is new,
 * unproven write-path code called from operator-worker.ts's hot path; a decisions-table
 * write must never fail a real customer's autonomous QA job.
 */
export async function recordOperatorDecisions(params: {
  jobId: string;
  taskId: string | null;
  decisions: DecisionRecordInput[];
}): Promise<void> {
  if (params.decisions.length === 0) return;
  try {
    await prisma.operatorDecision.createMany({
      data: params.decisions.map((d) => ({
        jobId: params.jobId,
        taskId: params.taskId ?? undefined,
        decisionType: d.decisionType,
        rationale: d.rationale,
        confidence: d.confidence,
        model: d.model ?? undefined,
        evidenceJson: d.evidenceJson as any,
      })),
    });
  } catch (err) {
    console.error("[operator-decisions] failed to record decisions (non-fatal)", err);
  }
}
