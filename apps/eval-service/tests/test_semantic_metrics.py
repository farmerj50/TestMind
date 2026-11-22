import pytest

from eval_service.llm_judge import Judge
from eval_service.schemas import EvaluationCase
from eval_service.semantic_metrics import APPLICABILITY, score_all_semantic_metrics


def case(**kwargs) -> EvaluationCase:
    return EvaluationCase(case_id=kwargs.pop("case_id", "c1"), **kwargs)


def test_applicability_requires_the_right_fields_per_metric():
    full = case(question="q", answer_text="a", contexts=["ctx"], ground_truth="gt")
    bare = case()

    assert APPLICABILITY["context_precision"](full) is True
    assert APPLICABILITY["context_precision"](bare) is False
    assert APPLICABILITY["context_recall"](full) is True
    assert APPLICABILITY["faithfulness"](full) is True
    assert APPLICABILITY["faithfulness"](case(question="q", answer_text="a")) is False  # no contexts
    assert APPLICABILITY["answer_correctness"](full) is True
    assert APPLICABILITY["answer_correctness"](case(question="q", answer_text="a")) is False  # no ground_truth
    assert APPLICABILITY["answer_relevancy"](case(question="q", answer_text="a")) is True
    assert APPLICABILITY["answer_relevancy"](bare) is False


@pytest.mark.asyncio
async def test_score_all_semantic_metrics_marks_inapplicable_cases_none(monkeypatch):
    # Mocked at the ascore boundary - see module docstring in this file's directory: a real
    # Ragas/instructor-backed fake LLM is too brittle to hand-build reliably, so these tests
    # verify the real applicability/aggregation/metric_kind wrapper logic with the actual
    # metric *call* stubbed, per the plan's own documented fallback for this exact situation.
    import eval_service.semantic_metrics as sm

    async def fake_score(case_obj, judge):
        return 0.75

    monkeypatch.setattr(sm, "_SCORERS", {name: fake_score for name in sm.SEMANTIC_METRIC_NAMES})

    applicable = case(case_id="applicable", question="q", answer_text="a", contexts=["ctx"], ground_truth="gt")
    inapplicable = case(case_id="inapplicable")  # no semantic fields at all

    results = await score_all_semantic_metrics([applicable, inapplicable], judge=Judge(llm=None, embeddings=None, llm_model="m", embedding_model="e"))

    for metric_name in results:
        assert results[metric_name]["applicable"] == 0.75
        assert results[metric_name]["inapplicable"] is None
