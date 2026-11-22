"""Phase 5 security audit tests: secret-leak protection, timing-safe auth comparison, and the
safe-scoring-error boundary that keeps ragas/deepeval's internal exceptions out of logs/responses.
"""
import inspect
import json
import os
import re
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

os.environ["TESTMIND_EVAL_API_KEY"] = "dev-test-key"

import eval_service.auth as auth_module  # noqa: E402
import eval_service.main as main_module  # noqa: E402
from eval_service.main import app  # noqa: E402

GOLDEN_DATASET = json.loads((Path(__file__).parent.parent / "examples" / "golden_dataset.json").read_text())

FAKE_SECRET = "sk-definitely-not-a-real-key-AUDIT-MARKER-0f93a2"


@pytest.fixture()
def client():
    return TestClient(app)


def test_require_api_key_uses_constant_time_comparison():
    """Source-inspection test, not a timing assertion (which would be flaky) - confirms
    secrets.compare_digest is actually used rather than a plain == that leaks timing info."""
    source = inspect.getsource(auth_module.require_api_key)
    assert "secrets.compare_digest" in source
    assert re.search(r"x_api_key\s*!=\s*expected", source) is None
    assert re.search(r"x_api_key\s*==\s*expected", source) is None


def test_semantic_scoring_exception_never_leaks_into_response_or_logs(client, monkeypatch, caplog):
    """A ragas-internal exception could in principle echo the case content it was scoring. The
    endpoint must never let that raw exception reach the HTTP response or the server log -
    _safe_scoring_error must reduce it to a generic message + the exception's type name only."""

    async def raising_semantic(cases, judge):
        raise RuntimeError(f"ragas internal failure while scoring secret={FAKE_SECRET} case={cases[0].case_id}")

    monkeypatch.setattr(main_module, "score_all_semantic_metrics", raising_semantic)

    case = dict(GOLDEN_DATASET["cases"][0])
    case["question"] = "What is the capital of France?"
    case["contexts"] = ["Paris is the capital of France."]
    case["ground_truth"] = "Paris"

    payload = {
        **{k: v for k, v in GOLDEN_DATASET.items() if k != "cases"},
        "cases": [case],
        "llm_api_key": FAKE_SECRET,
    }

    response = client.post("/v1/evaluations", json=payload, headers={"x-api-key": "dev-test-key"})

    assert response.status_code == 502
    assert FAKE_SECRET not in response.text
    assert "RuntimeError" in response.text  # the type name is fine to surface, the message is not

    for record in caplog.records:
        assert FAKE_SECRET not in record.getMessage()


def test_deepeval_scoring_exception_never_leaks_into_response_or_logs(client, monkeypatch, caplog):
    async def ok_semantic(cases, judge):
        from eval_service.semantic_metrics import APPLICABILITY, SEMANTIC_METRIC_NAMES

        return {name: {c.case_id: None for c in cases} for name in SEMANTIC_METRIC_NAMES}

    async def raising_deepeval(cases, llm_model, llm_api_key):
        raise RuntimeError(f"deepeval internal failure, key={llm_api_key} secret={FAKE_SECRET}")

    monkeypatch.setattr(main_module, "score_all_semantic_metrics", ok_semantic)
    monkeypatch.setattr(main_module, "score_all_deepeval_metrics", raising_deepeval)

    case = dict(GOLDEN_DATASET["cases"][0])
    case["question"] = "What is the capital of France?"
    case["contexts"] = ["Paris is the capital of France."]
    case["ground_truth"] = "Paris"

    payload = {
        **{k: v for k, v in GOLDEN_DATASET.items() if k != "cases"},
        "cases": [case],
        "llm_api_key": FAKE_SECRET,
    }

    response = client.post("/v1/evaluations", json=payload, headers={"x-api-key": "dev-test-key"})

    assert response.status_code == 502
    assert FAKE_SECRET not in response.text

    for record in caplog.records:
        assert FAKE_SECRET not in record.getMessage()
