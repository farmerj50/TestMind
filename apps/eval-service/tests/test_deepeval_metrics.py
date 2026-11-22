from eval_service.deepeval_metrics import APPLICABILITY, score_all_deepeval_metrics
from eval_service.schemas import EvaluationCase


def case(**kwargs) -> EvaluationCase:
    return EvaluationCase(case_id=kwargs.pop("case_id", "c1"), **kwargs)


def test_applicability_requires_the_right_fields_per_metric():
    full = case(question="q", answer_text="a", contexts=["ctx"], ground_truth="gt")
    bare = case()

    assert APPLICABILITY["hallucination"](full) is True
    assert APPLICABILITY["hallucination"](case(answer_text="a")) is False  # no contexts
    assert APPLICABILITY["deepeval_correctness"](full) is True
    assert APPLICABILITY["deepeval_correctness"](bare) is False


async def test_score_all_deepeval_metrics_never_imports_deepeval_when_nothing_is_applicable():
    # No case sets contexts/ground_truth at all - deepeval must not even be imported, let alone
    # invoked, matching Phase 1/2's zero-behavior-change guarantee for non-semantic callers.
    bare = case(case_id="bare", answer_text="hello")
    results = await score_all_deepeval_metrics([bare], llm_model="gpt-4o-mini", llm_api_key=None)
    for metric_name, per_case in results.items():
        assert per_case["bare"] is None


async def test_score_all_deepeval_metrics_marks_inapplicable_cases_none(monkeypatch):
    import eval_service.deepeval_metrics as dm

    class FakeTestCase:
        def __init__(self, **kwargs):
            pass

    class FakeMetric:
        async def a_measure(self, test_case, _show_indicator=False):
            return 0.6

    monkeypatch.setattr(
        dm, "_load_deepeval", lambda llm_model, llm_api_key: (FakeTestCase, FakeMetric(), FakeMetric())
    )

    applicable = case(case_id="applicable", question="q", answer_text="a", contexts=["ctx"], ground_truth="gt")
    inapplicable = case(case_id="inapplicable")

    results = await score_all_deepeval_metrics(
        [applicable, inapplicable], llm_model="gpt-4o-mini", llm_api_key="dummy"
    )

    for metric_name in results:
        assert results[metric_name]["applicable"] == 0.6
        assert results[metric_name]["inapplicable"] is None
