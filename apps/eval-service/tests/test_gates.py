from eval_service.gates import evaluate_gate, overall_status
from eval_service.schemas import GateResult, GateThreshold, MetricValue


def test_evaluate_gate_none_when_no_threshold_configured():
    metric = MetricValue(value=0.9, applicable_cases=5)
    assert evaluate_gate("recall_at_k", metric, None) is None


def test_evaluate_gate_skipped_no_data_when_zero_applicable_cases():
    metric = MetricValue(value=None, applicable_cases=0)
    result = evaluate_gate("abstention_accuracy", metric, GateThreshold(min=0.95))
    assert result.status == "skipped_no_data"
    assert result.actual is None


def test_evaluate_gate_pass_on_min_threshold():
    metric = MetricValue(value=0.9, applicable_cases=3)
    result = evaluate_gate("recall_at_k", metric, GateThreshold(min=0.8))
    assert result.status == "pass"


def test_evaluate_gate_fail_on_min_threshold():
    metric = MetricValue(value=0.5, applicable_cases=3)
    result = evaluate_gate("recall_at_k", metric, GateThreshold(min=0.8))
    assert result.status == "fail"


def test_evaluate_gate_pass_on_max_threshold():
    metric = MetricValue(value=1500, applicable_cases=3)
    result = evaluate_gate("p95_latency_ms", metric, GateThreshold(max=2000))
    assert result.status == "pass"


def test_evaluate_gate_fail_on_max_threshold():
    metric = MetricValue(value=2500, applicable_cases=3)
    result = evaluate_gate("p95_latency_ms", metric, GateThreshold(max=2000))
    assert result.status == "fail"


def test_overall_status_pass_when_all_gates_pass():
    gates = [GateResult(metric="a", status="pass", actual=1.0, threshold=0.5)]
    assert overall_status(gates) == "pass"


def test_overall_status_fail_outranks_skipped():
    # Deliberately pins the worst-of ordering: a dataset with one real failure and one gate
    # with no applicable data must report "fail", not "skipped_no_data" - the failure is the
    # more actionable signal and must never be masked by an unrelated skip.
    gates = [
        GateResult(metric="a", status="fail", actual=0.1, threshold=0.5),
        GateResult(metric="b", status="skipped_no_data", actual=None, threshold=0.9),
    ]
    assert overall_status(gates) == "fail"


def test_overall_status_skipped_when_no_failures_but_some_skipped():
    gates = [
        GateResult(metric="a", status="pass", actual=1.0, threshold=0.5),
        GateResult(metric="b", status="skipped_no_data", actual=None, threshold=0.9),
    ]
    assert overall_status(gates) == "skipped_no_data"


def test_overall_status_pass_when_no_gates_configured():
    assert overall_status([]) == "pass"
