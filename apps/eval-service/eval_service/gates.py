"""Quality-gate evaluation against configurable thresholds.

Fail-closed discipline: a metric with zero applicable cases is "skipped_no_data", never "pass".
A quality gate that has nothing to check against must never be reported as having been
satisfied - that would let a dataset with no coverage for a metric silently look like it passed.
"""
from __future__ import annotations

from .schemas import GateResult, GateThreshold, GateStatus, MetricValue


def evaluate_gate(metric_name: str, metric: MetricValue, threshold: GateThreshold | None) -> GateResult | None:
    """Returns None when no gate is configured for this metric (nothing to report)."""
    if threshold is None:
        return None
    if metric.applicable_cases == 0 or metric.value is None:
        return GateResult(metric=metric_name, status="skipped_no_data", actual=None, threshold=threshold.min or threshold.max)
    if threshold.min is not None:
        status: GateStatus = "pass" if metric.value >= threshold.min else "fail"
        return GateResult(metric=metric_name, status=status, actual=metric.value, threshold=threshold.min)
    if threshold.max is not None:
        status = "pass" if metric.value <= threshold.max else "fail"
        return GateResult(metric=metric_name, status=status, actual=metric.value, threshold=threshold.max)
    # A threshold object with neither min nor max configured has nothing to check.
    return GateResult(metric=metric_name, status="skipped_no_data", actual=metric.value, threshold=None)


def overall_status(gate_results: list[GateResult]) -> GateStatus:
    """Worst-of ordering: any fail outranks any skip, which outranks an all-pass result. This
    ordering is deliberate - a dataset that both fails one gate and has no data for another must
    report "fail", not "skipped_no_data", since the failure is the more actionable signal."""
    if not gate_results:
        return "pass"
    if any(g.status == "fail" for g in gate_results):
        return "fail"
    if any(g.status == "skipped_no_data" for g in gate_results):
        return "skipped_no_data"
    return "pass"
