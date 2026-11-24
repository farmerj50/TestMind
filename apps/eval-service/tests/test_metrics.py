from eval_service.metrics import (
    abstained_correctly,
    aggregate_metric,
    p95_latency,
    precision_at_k,
    recall_at_k,
    required_fact_rate,
)
from eval_service.schemas import EvaluationCase


def make_case(**overrides):
    defaults = dict(
        case_id="c1",
        retrieved_doc_ids=[],
        relevant_doc_ids=[],
        required_facts=[],
        answer_text="",
        should_abstain=False,
        abstained=False,
        latency_ms=None,
    )
    defaults.update(overrides)
    return EvaluationCase(**defaults)


def test_recall_at_k_computes_overlap():
    case = make_case(retrieved_doc_ids=["a", "b", "c"], relevant_doc_ids=["a", "z"])
    assert recall_at_k(case, k=3) == 0.5


def test_recall_at_k_none_when_no_relevant_docs():
    case = make_case(retrieved_doc_ids=["a"], relevant_doc_ids=[])
    assert recall_at_k(case, k=3) is None


def test_precision_at_k_computes_overlap():
    case = make_case(retrieved_doc_ids=["a", "b"], relevant_doc_ids=["a"])
    assert precision_at_k(case, k=2) == 0.5


def test_precision_at_k_none_when_nothing_retrieved():
    case = make_case(retrieved_doc_ids=[], relevant_doc_ids=["a"])
    assert precision_at_k(case, k=5) is None


def test_required_fact_rate_is_a_literal_substring_check():
    case = make_case(
        answer_text="Founded in 1998 and headquartered in Austin.",
        required_facts=["founded in 1998", "HEADQUARTERED IN AUSTIN", "has 500 employees"],
    )
    # 2 of 3 facts present as substrings (case-insensitive); the third is not.
    assert required_fact_rate(case) == 2 / 3


def test_required_fact_rate_does_not_do_semantic_matching():
    # A paraphrase that does NOT contain the literal substring must not be credited -
    # this pins down that the check is a smoke check, not semantic evaluation.
    case = make_case(answer_text="The firm began operations in 1998.", required_facts=["founded in 1998"])
    assert required_fact_rate(case) == 0.0


def test_required_fact_rate_none_when_no_facts_declared():
    case = make_case(answer_text="Anything.", required_facts=[])
    assert required_fact_rate(case) is None


def test_abstained_correctly_true_when_claims_match():
    case = make_case(should_abstain=True, abstained=True)
    assert abstained_correctly(case) is True


def test_abstained_correctly_false_when_claims_mismatch():
    case = make_case(should_abstain=True, abstained=False)
    assert abstained_correctly(case) is False


def test_abstained_correctly_none_when_abstention_not_being_tested():
    case = make_case(should_abstain=False, abstained=False)
    assert abstained_correctly(case) is None


def test_p95_latency_standard_percentile():
    assert p95_latency([100, 200, 300, 400, 500]) == 500


def test_p95_latency_none_when_no_data():
    assert p95_latency([]) is None


def test_aggregate_metric_averages_applicable_values_only():
    result = aggregate_metric([1.0, None, 0.5, None])
    assert result.value == 0.75
    assert result.applicable_cases == 2


def test_aggregate_metric_null_not_zero_when_nothing_applicable():
    result = aggregate_metric([None, None])
    assert result.value is None
    assert result.applicable_cases == 0
