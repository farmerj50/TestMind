// Evaluation Engine v1 (Phase 1). Calls the standalone apps/eval-service Python FastAPI
// service over HTTP from the BullMQ worker. Deliberately uses plain undici.request() rather
// than security/http-client.ts's probeScoped() - that module's SSRF/scope-allowlist checks
// exist for target-under-test URLs (an attacker-adjacent threat model); the eval-service is
// trusted internal infra reached via a plain env-var base URL, so only the timeout/error-shape
// idioms are borrowed, not the scope-enforcement machinery itself.
import { request } from "undici";
import { prisma } from "../prisma.js";
import { validatedEnv } from "../config/env.js";
import { snippet } from "../security/redaction.js";
import { resolveOpenAiKey } from "./llm.js";
import { recordAuditLog } from "../lib/audit-log.js";

// Phase 3: a case requests semantic (LLM-judged) evaluation if it carries any of these fields.
// Phase 1/2 callers never set them, so this check is a no-op for all existing traffic.
export function caseRequestsSemanticEval(c: any): boolean {
  return !!(c && (c.question || c.contexts || c.ground_truth));
}

const LOW_CONFIDENCE_DEFAULT_BAND: [number, number] = [0.4, 0.6];
const LOW_CONFIDENCE_GATE_MARGIN = 0.15;
const LLM_JUDGED_METRICS = [
  "context_precision", "context_recall", "faithfulness",
  "answer_correctness", "answer_relevancy", "hallucination", "deepeval_correctness",
] as const;

// Phase 3 correction: "low confidence" is an approximation, not a true model-confidence value -
// Ragas/DeepEval scores are 0-1 continuous judgments, not a calibrated confidence. If the caller
// configured a gate threshold for a metric, "uncertain" means close to that threshold (the score
// that would flip pass/fail on a slightly different judgment call); otherwise it falls back to a
// fixed mid-range band. Documented here rather than overstated as real model confidence.
export function isLowConfidence(metric: string, value: number, gatesConfig: any): boolean {
  const gate = gatesConfig?.[metric];
  if (gate && typeof gate === "object" && (typeof gate.min === "number" || typeof gate.max === "number")) {
    const threshold = typeof gate.min === "number" ? gate.min : gate.max;
    return Math.abs(value - threshold) <= LOW_CONFIDENCE_GATE_MARGIN;
  }
  return value >= LOW_CONFIDENCE_DEFAULT_BAND[0] && value <= LOW_CONFIDENCE_DEFAULT_BAND[1];
}

const EVAL_SERVICE_TIMEOUT_MS = 30_000;

// Safe-logging correction: every error path here truncates/snippets whatever text it stores or
// logs - an eval-service response body could echo back caller-supplied application data
// (answer text, retrieved doc content), so it must never be persisted/logged verbatim.
//
// `config` is an explicit override, defaulting to validatedEnv - a real production call never
// passes it, but it exists so this function is testable against a real local HTTP server
// without needing to reload config/env.ts's module-level singleton per test.
export async function callEvalService(
  body: unknown,
  config?: { baseUrl?: string; apiKey?: string }
): Promise<any> {
  const baseUrl = config?.baseUrl ?? validatedEnv.TM_EVAL_SERVICE_URL;
  const apiKey = config?.apiKey ?? validatedEnv.TM_EVAL_SERVICE_API_KEY;
  if (!baseUrl || !apiKey) {
    throw new Error("TM_EVAL_SERVICE_URL / TM_EVAL_SERVICE_API_KEY not configured");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EVAL_SERVICE_TIMEOUT_MS);
  let response;
  try {
    response = await request(new URL("/v1/evaluations", baseUrl).toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify(body),
      signal: controller.signal as any,
    });
  } catch (err: any) {
    throw new Error(`Eval service request failed: ${snippet(err?.message ?? String(err))}`);
  } finally {
    clearTimeout(timer);
  }

  const text = await response.body.text().catch(() => "");
  if (response.statusCode === 401 || response.statusCode === 403) {
    throw new Error("Eval service rejected the API key. Check TM_EVAL_SERVICE_API_KEY.");
  }
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`Eval service returned ${response.statusCode}: ${snippet(text)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Eval service did not return valid JSON: ${snippet(text)}`);
  }
}

export async function runEvaluation(payload: { runId: string; projectId: string }): Promise<void> {
  const run = await prisma.evaluationRun.findUnique({ where: { id: payload.runId } });
  if (!run) throw new Error(`EvaluationRun ${payload.runId} not found`);

  await prisma.evaluationRun.update({
    where: { id: run.id },
    data: { status: "running", startedAt: new Date() },
  });

  const cases = Array.isArray(run.casesJson) ? (run.casesJson as any[]) : [];
  const needsSemanticEval = cases.some(caseRequestsSemanticEval);

  let llmFields: { llm_api_key?: string; llm_model?: string; embedding_model?: string } = {};
  if (needsSemanticEval) {
    const apiKey = await resolveOpenAiKey(run.projectId);
    if (!apiKey) {
      await prisma.evaluationRun.update({
        where: { id: run.id },
        data: {
          status: "failed",
          finishedAt: new Date(),
          error: "Semantic evaluation requested (question/contexts/ground_truth present) but no OpenAI key is configured for this project.",
        },
      });
      return;
    }
    llmFields = { llm_api_key: apiKey };
  }

  const result = await callEvalService({
    dataset_id: run.datasetId,
    dataset_version: run.datasetVersion,
    application_id: run.applicationId,
    application_version: run.applicationVersion,
    gates: run.gatesConfig ?? undefined,
    cases: run.casesJson,
    ...llmFields,
  });

  const caseResults = Array.isArray(result?.case_results) ? result.case_results : [];

  await prisma.$transaction([
    prisma.evaluationResult.createMany({
      data: caseResults.map((c: any) => ({
        runId: run.id,
        caseId: c.case_id,
        recallAtK: c.recall_at_k ?? null,
        precisionAtK: c.precision_at_k ?? null,
        requiredFactRate: c.required_fact_rate ?? null,
        abstainedCorrectly: c.abstained_correctly ?? null,
        latencyMs: c.latency_ms ?? null,
        raw: c,
      })),
    }),
    prisma.evaluationRun.update({
      where: { id: run.id },
      data: {
        status: "succeeded",
        finishedAt: new Date(),
        evaluatorVersion: result?.evaluator_version ?? null,
        overallGateStatus: result?.overall_gate_status ?? null,
        metricsSummary: result?.metrics ?? null,
        evaluatorMetadata: result?.evaluator_metadata ?? undefined,
      },
    }),
  ]);

  await queueHumanReviewCandidates(run.id, run.projectId, run.gatesConfig, caseResults).catch((err) => {
    console.error("[evaluation-service] human-review queueing failed", { runId: run.id, error: snippet(err?.message ?? String(err)) });
  });
}

// Phase 3: queue a HumanInterventionCandidate for any llm_judged metric value landing in an
// "uncertain" band (see isLowConfidence above). HumanInterventionCandidate has no FK column for
// EvaluationRun (it's a shared model across several existing features) - every relation FK is
// left null and the reference lives in contextJson, same shape a reviewer can look up from the
// Evaluations dashboard.
async function queueHumanReviewCandidates(runId: string, projectId: string, gatesConfig: unknown, caseResults: any[]): Promise<void> {
  const candidates: { projectId: string; source: string; reason: string; status: string; contextJson: any }[] = [];
  for (const c of caseResults) {
    for (const metric of LLM_JUDGED_METRICS) {
      const value = c?.[metric];
      if (typeof value !== "number") continue;
      if (!isLowConfidence(metric, value, gatesConfig)) continue;
      candidates.push({
        projectId,
        source: "evaluation-llm-judged",
        reason: `Metric "${metric}" scored ${value.toFixed(3)} for case ${c.case_id} - within the uncertain band for this run's gate; needs human review.`,
        status: "open",
        contextJson: { evaluationRunId: runId, caseId: c.case_id, metric, value, gate: (gatesConfig as any)?.[metric] ?? null },
      });
    }
  }
  if (!candidates.length) return;
  await prisma.humanInterventionCandidate.createMany({ data: candidates });
  await recordAuditLog({
    projectId,
    action: "human_review_candidate.created",
    targetType: "EvaluationRun",
    targetId: runId,
    metadataJson: { count: candidates.length },
  });
}
