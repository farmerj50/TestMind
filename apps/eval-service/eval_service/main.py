"""TestMind AI Evaluation Engine - standalone FastAPI service.

Prototype, not a bank-certified production deployment (see README.md's Current Limitations
section). This module wires the request/response contract (schemas.py) to the deterministic
metrics (metrics.py) and quality gates (gates.py) behind an x-api-key check (auth.py).

Safe-logging correction: this module never logs a request/response body at full length. The
only thing ever logged is the case count and dataset/application identifiers - never answer
text, retrieved document content, or required facts, which may carry sensitive application data.
"""
from __future__ import annotations

import logging

from fastapi import Depends, FastAPI, HTTPException

from .auth import require_api_key
from .deepeval_metrics import DEEPEVAL_METRIC_NAMES, DeepEvalNotAvailable, score_all_deepeval_metrics
from .gates import evaluate_gate, overall_status
from .llm_judge import SemanticEvaluationNotConfigured, build_judge, case_requests_semantic_evaluation
from .metrics import (
    abstained_correctly,
    aggregate_metric,
    p95_latency,
    precision_at_k,
    recall_at_k,
    required_fact_rate,
)
from .schemas import (
    EVALUATOR_VERSION,
    CaseResult,
    EvaluationRequest,
    EvaluationResponse,
    EvaluatorMetadata,
    MetricValue,
)
from .semantic_metrics import SEMANTIC_METRIC_NAMES, score_all_semantic_metrics

logger = logging.getLogger("eval_service")

app = FastAPI(title="TestMind AI Evaluation Engine", version=EVALUATOR_VERSION)


def _safe_scoring_error(source: str, exc: Exception) -> HTTPException:
    """ragas/deepeval's internal LLM-judge exceptions are not guaranteed to be free of the case
    content (question/contexts/ground_truth/answer_text) they were scoring - some LLM-eval
    libraries echo the failing record into their error messages for debuggability. Letting such
    an exception propagate unhandled would have Uvicorn's default logger print its full
    str()/traceback to stdout, violating this module's own "never log case content" rule even
    though FastAPI's default 500 handler already keeps the HTTP *response* itself generic. Log
    only the exception's type name (never its message or args) and return a safe, generic 502.
    """
    logger.error("%s scoring failed: %s", source, type(exc).__name__)
    return HTTPException(status_code=502, detail=f"{source} scoring failed ({type(exc).__name__}).")

CASE_RESULT_FIELD_BY_METRIC = {
    "context_precision": "context_precision",
    "context_recall": "context_recall",
    "faithfulness": "faithfulness",
    "answer_correctness": "answer_correctness",
    "answer_relevancy": "answer_relevancy",
    "hallucination": "hallucination",
    "deepeval_correctness": "deepeval_correctness",
}


@app.get("/healthz")
def healthz() -> dict:
    return {"status": "ok", "evaluator_version": EVALUATOR_VERSION}


@app.post("/v1/evaluations", response_model=EvaluationResponse, dependencies=[Depends(require_api_key)])
async def run_evaluation(request: EvaluationRequest) -> EvaluationResponse:
    # Safe logging: identifiers and counts only, never case content.
    logger.info(
        "evaluation request: dataset=%s/%s application=%s/%s cases=%d",
        request.dataset_id,
        request.dataset_version,
        request.application_id,
        request.application_version,
        len(request.cases),
    )

    recall_k = request.gates.get("recall_at_k").k if "recall_at_k" in request.gates and request.gates["recall_at_k"].k else 5
    precision_k = (
        request.gates.get("precision_at_k").k if "precision_at_k" in request.gates and request.gates["precision_at_k"].k else 5
    )

    recall_values: list[float | None] = []
    precision_values: list[float | None] = []
    fact_rate_values: list[float | None] = []
    abstention_values: list[bool | None] = []
    latency_values: list[float] = []
    case_results: list[CaseResult] = []

    for case in request.cases:
        recall = recall_at_k(case, recall_k)
        precision = precision_at_k(case, precision_k)
        fact_rate = required_fact_rate(case)
        abstained = abstained_correctly(case)

        recall_values.append(recall)
        precision_values.append(precision)
        fact_rate_values.append(fact_rate)
        abstention_values.append(abstained)
        if case.latency_ms is not None:
            latency_values.append(case.latency_ms)

        case_results.append(
            CaseResult(
                case_id=case.case_id,
                recall_at_k=recall,
                precision_at_k=precision,
                required_fact_rate=fact_rate,
                abstained_correctly=abstained,
                latency_ms=case.latency_ms,
            )
        )

    abstention_as_float: list[float | None] = [
        (1.0 if v else 0.0) if v is not None else None for v in abstention_values
    ]

    metrics: dict[str, MetricValue] = {
        "recall_at_k": aggregate_metric(recall_values),
        "precision_at_k": aggregate_metric(precision_values),
        "required_fact_rate": aggregate_metric(fact_rate_values),
        "abstention_accuracy": aggregate_metric(abstention_as_float),
        "p95_latency_ms": MetricValue(
            value=p95_latency(latency_values),
            applicable_cases=len(latency_values),
        ),
    }

    evaluator_metadata = EvaluatorMetadata()
    case_results_by_id = {c.case_id: c for c in case_results}

    # Phase 3: semantic metrics are computed only when a case actually requests them (sets
    # contexts and/or ground_truth) - a Phase 1/2 caller that never sets these fields gets a
    # byte-identical response to before, with zero behavior change.
    if case_requests_semantic_evaluation(request.cases):
        try:
            judge = build_judge(request.llm_api_key, request.llm_model, request.embedding_model)
        except SemanticEvaluationNotConfigured as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

        import ragas

        evaluator_metadata.ragas_version = ragas.__version__
        evaluator_metadata.llm_model = request.llm_model
        evaluator_metadata.embedding_model = request.embedding_model

        try:
            semantic_results = await score_all_semantic_metrics(request.cases, judge)
        except Exception as exc:  # noqa: BLE001 - deliberately broad, see _safe_scoring_error
            raise _safe_scoring_error("ragas", exc) from exc
        for metric_name in SEMANTIC_METRIC_NAMES:
            per_case = semantic_results[metric_name]
            agg = aggregate_metric(list(per_case.values()))
            metrics[metric_name] = MetricValue(
                value=agg.value, applicable_cases=agg.applicable_cases, metric_kind="llm_judged"
            )
            for case_id, score in per_case.items():
                setattr(case_results_by_id[case_id], CASE_RESULT_FIELD_BY_METRIC[metric_name], score)

        try:
            deepeval_results = await score_all_deepeval_metrics(
                request.cases, request.llm_model, request.llm_api_key
            )
        except DeepEvalNotAvailable as exc:
            raise HTTPException(status_code=500, detail=str(exc)) from exc
        except Exception as exc:  # noqa: BLE001 - deliberately broad, see _safe_scoring_error
            raise _safe_scoring_error("deepeval", exc) from exc

        any_deepeval_applicable = any(
            any(score is not None for score in per_case.values()) for per_case in deepeval_results.values()
        )
        if any_deepeval_applicable:
            import deepeval

            evaluator_metadata.deepeval_version = getattr(deepeval, "__version__", None)
            for metric_name in DEEPEVAL_METRIC_NAMES:
                per_case = deepeval_results[metric_name]
                agg = aggregate_metric(list(per_case.values()))
                metrics[metric_name] = MetricValue(
                    value=agg.value, applicable_cases=agg.applicable_cases, metric_kind="llm_judged"
                )
                for case_id, score in per_case.items():
                    setattr(case_results_by_id[case_id], CASE_RESULT_FIELD_BY_METRIC[metric_name], score)

    gate_results = []
    for metric_name, metric_value in metrics.items():
        gate = evaluate_gate(metric_name, metric_value, request.gates.get(metric_name))
        if gate is not None:
            gate_results.append(gate)

    return EvaluationResponse(
        dataset_id=request.dataset_id,
        dataset_version=request.dataset_version,
        application_id=request.application_id,
        application_version=request.application_version,
        evaluator_version=EVALUATOR_VERSION,
        case_count=len(request.cases),
        metrics=metrics,
        gate_results=gate_results,
        overall_gate_status=overall_status(gate_results),
        case_results=case_results,
        evaluator_metadata=evaluator_metadata,
    )
