"""Optional DeepEval-backed metrics: hallucination and a GEval-based correctness judge.

DeepEval is an optional dependency - imported only inside these functions (call-time, not
module-load-time) so a missing/broken deepeval install never breaks the rest of this service
(deterministic metrics, Ragas metrics) and only surfaces as a clear error when a DeepEval
metric is actually applicable and invoked. Both metrics here are `metric_kind: "llm_judged"`.
"""
from __future__ import annotations

import asyncio

from .schemas import EvaluationCase

DEEPEVAL_METRIC_NAMES = ("hallucination", "deepeval_correctness")


class DeepEvalNotAvailable(Exception):
    """Raised when a DeepEval-backed metric is applicable/requested but the deepeval package
    is not importable or failed to load."""


def _hallucination_applicable(case: EvaluationCase) -> bool:
    return bool(case.answer_text and case.contexts)


def _correctness_applicable(case: EvaluationCase) -> bool:
    return bool(case.question and case.answer_text and case.ground_truth)


APPLICABILITY = {
    "hallucination": _hallucination_applicable,
    "deepeval_correctness": _correctness_applicable,
}


def _load_deepeval(llm_model: str, llm_api_key: str):
    try:
        from deepeval.metrics import GEval, HallucinationMetric
        from deepeval.models import OpenAIModel
        from deepeval.test_case import LLMTestCase, LLMTestCaseParams
    except Exception as exc:  # pragma: no cover - exercised via a monkeypatched import failure
        raise DeepEvalNotAvailable(f"deepeval is not available: {exc}") from exc

    model = OpenAIModel(model=llm_model, api_key=llm_api_key)
    hallucination_metric = HallucinationMetric(model=model, async_mode=True)
    correctness_metric = GEval(
        name="Correctness",
        criteria="Determine whether the actual output is factually correct and consistent with the expected output.",
        evaluation_params=[
            LLMTestCaseParams.INPUT,
            LLMTestCaseParams.ACTUAL_OUTPUT,
            LLMTestCaseParams.EXPECTED_OUTPUT,
        ],
        model=model,
        async_mode=True,
    )
    return LLMTestCase, hallucination_metric, correctness_metric


async def score_all_deepeval_metrics(
    cases: list[EvaluationCase], llm_model: str, llm_api_key: str
) -> dict[str, dict[str, float | None]]:
    """Returns {metric_name: {case_id: score_or_None}}, same applicability/None convention as
    semantic_metrics.py. Only loads deepeval if at least one case is applicable to at least one
    DeepEval metric - never imports it on a pure-deterministic or pure-Ragas request."""
    applicable_any = any(
        any(fn(case) for fn in APPLICABILITY.values()) for case in cases
    )
    results: dict[str, dict[str, float | None]] = {name: {} for name in DEEPEVAL_METRIC_NAMES}
    if not applicable_any:
        for name in DEEPEVAL_METRIC_NAMES:
            for case in cases:
                results[name][case.case_id] = None
        return results

    LLMTestCase, hallucination_metric, correctness_metric = _load_deepeval(llm_model, llm_api_key)

    async def run_one(metric_name: str, case: EvaluationCase) -> None:
        if not APPLICABILITY[metric_name](case):
            results[metric_name][case.case_id] = None
            return
        if metric_name == "hallucination":
            test_case = LLMTestCase(input=case.question or "", actual_output=case.answer_text, context=case.contexts)
            score = await hallucination_metric.a_measure(test_case, _show_indicator=False)
        else:
            test_case = LLMTestCase(
                input=case.question or "", actual_output=case.answer_text, expected_output=case.ground_truth
            )
            score = await correctness_metric.a_measure(test_case, _show_indicator=False)
        results[metric_name][case.case_id] = float(score)

    await asyncio.gather(
        *[run_one(metric_name, case) for metric_name in DEEPEVAL_METRIC_NAMES for case in cases]
    )
    return results
