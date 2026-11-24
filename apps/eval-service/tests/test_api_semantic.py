import json
import os
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

os.environ["TESTMIND_EVAL_API_KEY"] = "dev-test-key"

import eval_service.main as main_module  # noqa: E402
from eval_service.main import app  # noqa: E402

GOLDEN_DATASET = json.loads((Path(__file__).parent.parent / "examples" / "golden_dataset.json").read_text())


@pytest.fixture()
def client():
    return TestClient(app)


@pytest.fixture()
def stub_semantic_metrics(monkeypatch):
    """Stubs the two heavy metric-scoring entry points at exactly the boundary main.py calls
    them, so these integration tests exercise the real route/aggregation/gating/metadata wiring
    without any real OpenAI/instructor call. See test_semantic_metrics.py / test_deepeval_metrics.py
    for unit coverage of the scoring functions themselves."""

    async def fake_semantic(cases, judge):
        from eval_service.semantic_metrics import SEMANTIC_METRIC_NAMES, APPLICABILITY

        return {
            name: {c.case_id: (0.9 if APPLICABILITY[name](c) else None) for c in cases}
            for name in SEMANTIC_METRIC_NAMES
        }

    async def fake_deepeval(cases, llm_model, llm_api_key):
        from eval_service.deepeval_metrics import DEEPEVAL_METRIC_NAMES, APPLICABILITY

        return {
            name: {c.case_id: (0.8 if APPLICABILITY[name](c) else None) for c in cases}
            for name in DEEPEVAL_METRIC_NAMES
        }

    monkeypatch.setattr(main_module, "score_all_semantic_metrics", fake_semantic)
    monkeypatch.setattr(main_module, "score_all_deepeval_metrics", fake_deepeval)


def test_golden_dataset_regression_is_byte_identical_to_phase1(client):
    # No case in the golden dataset sets contexts/ground_truth/question - this must take the
    # exact same path as before Phase 3, with zero semantic metrics appearing and a null
    # evaluator_metadata, proving Phase 1/2 callers are completely unaffected.
    res = client.post("/v1/evaluations", json=GOLDEN_DATASET, headers={"x-api-key": "dev-test-key"})
    assert res.status_code == 200
    body = res.json()

    assert body["case_count"] == 3
    for metric_name in ["context_precision", "context_recall", "faithfulness", "answer_correctness", "answer_relevancy", "hallucination", "deepeval_correctness"]:
        assert metric_name not in body["metrics"]
    for case_result in body["case_results"]:
        assert case_result["context_precision"] is None
        assert case_result["faithfulness"] is None
    assert body["evaluator_metadata"] == {
        "ragas_version": None,
        "deepeval_version": None,
        "llm_model": None,
        "embedding_model": None,
    }
    # The 5 deterministic metrics are still exactly as before.
    for metric in body["metrics"].values():
        assert metric["metric_kind"] == "deterministic"


def test_semantic_evaluation_without_api_key_fails_closed_with_400(client):
    request_body = {
        "dataset_id": "ds-1",
        "dataset_version": "v1",
        "application_id": "app-1",
        "application_version": "v1",
        "cases": [{"case_id": "c1", "answer_text": "Paris is the capital.", "contexts": ["France's capital is Paris."]}],
    }
    res = client.post("/v1/evaluations", json=request_body, headers={"x-api-key": "dev-test-key"})
    assert res.status_code == 400
    assert "llm_api_key" in res.json()["detail"]


def test_mixed_dataset_reports_correct_applicable_case_counts(client, stub_semantic_metrics):
    request_body = {
        "dataset_id": "ds-1",
        "dataset_version": "v1",
        "application_id": "app-1",
        "application_version": "v1",
        "llm_api_key": "dummy-key",
        "cases": [
            {
                "case_id": "semantic-case",
                "question": "What is the capital of France?",
                "answer_text": "Paris is the capital of France.",
                "contexts": ["France's capital city is Paris."],
                "ground_truth": "Paris",
            },
            {"case_id": "plain-case", "answer_text": "unrelated"},
        ],
    }
    res = client.post("/v1/evaluations", json=request_body, headers={"x-api-key": "dev-test-key"})
    assert res.status_code == 200
    body = res.json()

    # Only 1 of 2 cases is applicable to every semantic/deepeval metric.
    for metric_name in ["context_precision", "context_recall", "faithfulness", "answer_correctness", "answer_relevancy"]:
        assert body["metrics"][metric_name]["applicable_cases"] == 1
        assert body["metrics"][metric_name]["metric_kind"] == "llm_judged"
    assert body["metrics"]["hallucination"]["applicable_cases"] == 1
    assert body["metrics"]["deepeval_correctness"]["applicable_cases"] == 1

    by_id = {c["case_id"]: c for c in body["case_results"]}
    assert by_id["semantic-case"]["faithfulness"] == 0.9
    assert by_id["plain-case"]["faithfulness"] is None

    assert body["evaluator_metadata"]["llm_model"] == "gpt-4o-mini"
    assert body["evaluator_metadata"]["ragas_version"]
    assert body["evaluator_metadata"]["deepeval_version"]


def test_semantic_metrics_absent_when_no_case_requests_them_even_with_a_key_present(client, stub_semantic_metrics):
    # llm_api_key present but no case sets contexts/ground_truth - zero semantic work should be
    # attempted (case_requests_semantic_evaluation gates the whole branch in main.py).
    request_body = {
        "dataset_id": "ds-1",
        "dataset_version": "v1",
        "application_id": "app-1",
        "application_version": "v1",
        "llm_api_key": "dummy-key",
        "cases": [{"case_id": "c1", "answer_text": "hello"}],
    }
    res = client.post("/v1/evaluations", json=request_body, headers={"x-api-key": "dev-test-key"})
    assert res.status_code == 200
    body = res.json()
    for metric_name in ["context_precision", "faithfulness", "hallucination", "deepeval_correctness"]:
        assert metric_name not in body["metrics"]
