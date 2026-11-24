"""Ragas-backed semantic (LLM-judged) metrics. Unlike metrics.py, these call a real LLM and
are therefore probabilistic, not deterministic - every metric here is tagged
`metric_kind: "llm_judged"` in the response (schemas.py), and callers must never assume a
re-run reproduces an identical score the way the deterministic metrics do.

Applicability discipline matches metrics.py exactly: a case missing the fields a given metric
needs is simply not applicable to it (never silently treated as passing). `llm`/`embeddings` are
always injected by the caller (llm_judge.py) - this module never constructs its own client.
"""
from __future__ import annotations

import asyncio

from ragas.metrics.collections import (
    AnswerCorrectness,
    AnswerRelevancy,
    ContextPrecision,
    ContextRecall,
    Faithfulness,
)

from .llm_judge import Judge
from .schemas import EvaluationCase

SEMANTIC_METRIC_NAMES = (
    "context_precision",
    "context_recall",
    "faithfulness",
    "answer_correctness",
    "answer_relevancy",
)


def _context_precision_applicable(case: EvaluationCase) -> bool:
    return bool(case.contexts and case.ground_truth)


def _context_recall_applicable(case: EvaluationCase) -> bool:
    return bool(case.contexts and case.ground_truth)


def _faithfulness_applicable(case: EvaluationCase) -> bool:
    return bool(case.question and case.answer_text and case.contexts)


def _answer_correctness_applicable(case: EvaluationCase) -> bool:
    return bool(case.question and case.answer_text and case.ground_truth)


def _answer_relevancy_applicable(case: EvaluationCase) -> bool:
    return bool(case.question and case.answer_text)


APPLICABILITY = {
    "context_precision": _context_precision_applicable,
    "context_recall": _context_recall_applicable,
    "faithfulness": _faithfulness_applicable,
    "answer_correctness": _answer_correctness_applicable,
    "answer_relevancy": _answer_relevancy_applicable,
}


async def _score_context_precision(case: EvaluationCase, judge: Judge) -> float:
    metric = ContextPrecision(llm=judge.llm)
    result = await metric.ascore(user_input=case.question, reference=case.ground_truth, retrieved_contexts=case.contexts)
    return result.value


async def _score_context_recall(case: EvaluationCase, judge: Judge) -> float:
    metric = ContextRecall(llm=judge.llm)
    result = await metric.ascore(user_input=case.question, retrieved_contexts=case.contexts, reference=case.ground_truth)
    return result.value


async def _score_faithfulness(case: EvaluationCase, judge: Judge) -> float:
    metric = Faithfulness(llm=judge.llm)
    result = await metric.ascore(user_input=case.question, response=case.answer_text, retrieved_contexts=case.contexts)
    return result.value


async def _score_answer_correctness(case: EvaluationCase, judge: Judge) -> float:
    metric = AnswerCorrectness(llm=judge.llm, embeddings=judge.embeddings)
    result = await metric.ascore(user_input=case.question, response=case.answer_text, reference=case.ground_truth)
    return result.value


async def _score_answer_relevancy(case: EvaluationCase, judge: Judge) -> float:
    metric = AnswerRelevancy(llm=judge.llm, embeddings=judge.embeddings)
    result = await metric.ascore(user_input=case.question, response=case.answer_text)
    return result.value


_SCORERS = {
    "context_precision": _score_context_precision,
    "context_recall": _score_context_recall,
    "faithfulness": _score_faithfulness,
    "answer_correctness": _score_answer_correctness,
    "answer_relevancy": _score_answer_relevancy,
}


async def score_all_semantic_metrics(
    cases: list[EvaluationCase], judge: Judge
) -> dict[str, dict[str, float | None]]:
    """Returns {metric_name: {case_id: score_or_None}}. A case not applicable to a metric maps
    to None for that metric - callers aggregate exactly like metrics.py's deterministic metrics
    (None values are excluded from applicable_cases, never averaged in as 0 or a pass)."""
    results: dict[str, dict[str, float | None]] = {name: {} for name in SEMANTIC_METRIC_NAMES}

    async def run_one(metric_name: str, case: EvaluationCase) -> None:
        if not APPLICABILITY[metric_name](case):
            results[metric_name][case.case_id] = None
            return
        results[metric_name][case.case_id] = await _SCORERS[metric_name](case, judge)

    await asyncio.gather(
        *[run_one(metric_name, case) for metric_name in SEMANTIC_METRIC_NAMES for case in cases]
    )
    return results
