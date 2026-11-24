import pytest

from eval_service.llm_judge import SemanticEvaluationNotConfigured, build_judge, case_requests_semantic_evaluation
from eval_service.schemas import EvaluationCase


def case(**kwargs) -> EvaluationCase:
    return EvaluationCase(case_id=kwargs.pop("case_id", "c1"), **kwargs)


def test_case_requests_semantic_evaluation_true_when_contexts_set():
    assert case_requests_semantic_evaluation([case(contexts=["x"])]) is True


def test_case_requests_semantic_evaluation_true_when_ground_truth_set():
    assert case_requests_semantic_evaluation([case(ground_truth="gt")]) is True


def test_case_requests_semantic_evaluation_false_for_plain_phase1_case():
    assert case_requests_semantic_evaluation([case(answer_text="hello")]) is False


def test_build_judge_fails_closed_without_an_api_key():
    with pytest.raises(SemanticEvaluationNotConfigured):
        build_judge(None, "gpt-4o-mini", "text-embedding-3-small")


def test_build_judge_succeeds_with_a_key_present():
    judge = build_judge("dummy-key-not-real", "gpt-4o-mini", "text-embedding-3-small")
    assert judge.llm_model == "gpt-4o-mini"
    assert judge.embedding_model == "text-embedding-3-small"
