"""Deterministic evaluation metrics. Pure functions, no I/O, no LLM calls.

IMPORTANT - read before extending this module: every metric here is a literal, deterministic
computation. None of them implement semantic evaluation, factual correctness, or RAG
groundedness. Do not describe them as doing so. Phase 3 (Ragas/DeepEval, LLM-judged metrics)
is where semantic/probabilistic evaluation is added, under its own `metric_kind: "llm_judged"`
tag (see schemas.py) - never silently upgrade one of these deterministic metrics to look
LLM-judged, and never report an LLM-judged metric under this module without that tag.
"""
from __future__ import annotations

from .schemas import EvaluationCase, MetricValue


def recall_at_k(case: EvaluationCase, k: int) -> float | None:
    """Fraction of relevant docs that appear in the top-k retrieved docs. None (not
    applicable) when the case declares no relevant docs at all."""
    if not case.relevant_doc_ids:
        return None
    top_k = set(case.retrieved_doc_ids[:k])
    relevant = set(case.relevant_doc_ids)
    return len(top_k & relevant) / len(relevant)


def precision_at_k(case: EvaluationCase, k: int) -> float | None:
    """Fraction of the top-k retrieved docs that are relevant. None when the case retrieved
    nothing (nothing to score precision over)."""
    top_k = case.retrieved_doc_ids[:k]
    if not top_k:
        return None
    relevant = set(case.relevant_doc_ids)
    hits = sum(1 for doc_id in top_k if doc_id in relevant)
    return hits / len(top_k)


def required_fact_rate(case: EvaluationCase) -> float | None:
    """Literal, case-insensitive SUBSTRING SMOKE CHECK - not semantic evaluation, not factual
    correctness verification, not groundedness. Each required fact is checked with
    `fact.lower() in answer_text.lower()`; the result is the fraction of facts found this way.
    None when the case declares no required facts (nothing to check)."""
    if not case.required_facts:
        return None
    answer_lower = case.answer_text.lower()
    hits = sum(1 for fact in case.required_facts if fact.lower() in answer_lower)
    return hits / len(case.required_facts)


def abstained_correctly(case: EvaluationCase) -> bool | None:
    """Compares two caller-supplied booleans (`should_abstain` vs `abstained`). `abstained` is
    TRUSTED INPUT from the caller - this function does not and cannot verify from source
    evidence whether the system actually abstained; it only checks the caller's own claim
    against the caller's own expectation. None when should_abstain is False (abstention
    behavior wasn't being tested for this case)."""
    if not case.should_abstain:
        return None
    return case.abstained == case.should_abstain


def p95_latency(latencies_ms: list[float]) -> float | None:
    """Standard 95th-percentile latency. None when no case supplied a latency_ms value."""
    if not latencies_ms:
        return None
    ordered = sorted(latencies_ms)
    index = min(len(ordered) - 1, round(0.95 * (len(ordered) - 1)))
    return ordered[index]


def aggregate_metric(values: list[float | None]) -> MetricValue:
    """Averages the non-None values from a list of per-case metric results, reporting how many
    cases actually contributed (applicable_cases). value is None (not 0.0) when zero cases
    applied - a metric with no applicable cases must never silently read as a passing average
    of nothing."""
    applicable = [v for v in values if v is not None]
    if not applicable:
        return MetricValue(value=None, applicable_cases=0)
    return MetricValue(value=sum(applicable) / len(applicable), applicable_cases=len(applicable))
