import json
import os
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

os.environ["TESTMIND_EVAL_API_KEY"] = "dev-test-key"

from eval_service.main import app  # noqa: E402  (must follow the env var set above)

GOLDEN_DATASET = json.loads((Path(__file__).parent.parent / "examples" / "golden_dataset.json").read_text())


@pytest.fixture()
def client():
    return TestClient(app)


def test_healthz_is_unauthenticated(client):
    res = client.get("/healthz")
    assert res.status_code == 200
    assert res.json()["status"] == "ok"


def test_evaluations_requires_api_key(client):
    res = client.post("/v1/evaluations", json=GOLDEN_DATASET)
    assert res.status_code in (401, 422)  # 422 if FastAPI rejects the missing header before auth.py runs


def test_evaluations_rejects_wrong_api_key(client):
    res = client.post("/v1/evaluations", json=GOLDEN_DATASET, headers={"x-api-key": "wrong"})
    assert res.status_code == 401


def test_evaluations_golden_dataset_round_trip(client):
    res = client.post("/v1/evaluations", json=GOLDEN_DATASET, headers={"x-api-key": "dev-test-key"})
    assert res.status_code == 200
    body = res.json()

    assert body["dataset_id"] == "support-kb-v3"
    assert body["case_count"] == 3
    assert body["evaluator_version"]

    # q-002 and q-003 declare no required_facts - their per-case required_fact_rate is null,
    # proving the null/skip path works at the per-case level.
    by_id = {c["case_id"]: c for c in body["case_results"]}
    assert by_id["q-002"]["required_fact_rate"] is None
    assert by_id["q-003"]["required_fact_rate"] is None
    assert by_id["q-001"]["required_fact_rate"] == 1.0  # both facts present as literal substrings

    # Every metric is tagged with its kind - Phase 1 is deterministic-only.
    for metric in body["metrics"].values():
        assert metric["metric_kind"] == "deterministic"


def test_evaluations_gate_skipped_no_data_when_no_case_has_the_relevant_field():
    # A dataset where NOT ONE case declares required_facts: the aggregate required_fact_rate
    # metric itself has zero applicable cases, so its gate must report "skipped_no_data", never
    # a silently-passing average of nothing.
    request_body = {
        "dataset_id": "ds-1",
        "dataset_version": "v1",
        "application_id": "app-1",
        "application_version": "v1",
        "gates": {"required_fact_rate": {"min": 0.9}},
        "cases": [
            {"case_id": "c1", "answer_text": "hello", "required_facts": []},
            {"case_id": "c2", "answer_text": "world", "required_facts": []},
        ],
    }
    client = TestClient(app)
    res = client.post("/v1/evaluations", json=request_body, headers={"x-api-key": "dev-test-key"})
    assert res.status_code == 200
    body = res.json()

    assert body["metrics"]["required_fact_rate"]["value"] is None
    assert body["metrics"]["required_fact_rate"]["applicable_cases"] == 0
    gate = next(g for g in body["gate_results"] if g["metric"] == "required_fact_rate")
    assert gate["status"] == "skipped_no_data"
    assert body["overall_gate_status"] == "skipped_no_data"


def test_evaluations_rejects_oversized_case_list():
    # Data-minimization correction: the service must reject (not silently truncate or accept)
    # a request exceeding MAX_CASES_PER_REQUEST.
    from eval_service.schemas import MAX_CASES_PER_REQUEST

    request_body = {
        "dataset_id": "ds-1",
        "dataset_version": "v1",
        "application_id": "app-1",
        "application_version": "v1",
        "cases": [{"case_id": f"c{i}", "answer_text": "x"} for i in range(MAX_CASES_PER_REQUEST + 1)],
    }
    client = TestClient(app)
    res = client.post("/v1/evaluations", json=request_body, headers={"x-api-key": "dev-test-key"})
    assert res.status_code == 422


def test_evaluations_fails_closed_when_server_has_no_api_key_configured(monkeypatch):
    # Fail-closed property: an unconfigured server must refuse every request (500), never
    # silently accept any key or fall back to "no auth required".
    monkeypatch.delenv("TESTMIND_EVAL_API_KEY", raising=False)
    client = TestClient(app)
    res = client.post("/v1/evaluations", json=GOLDEN_DATASET, headers={"x-api-key": "anything"})
    assert res.status_code == 500


def test_evaluations_rejects_unknown_fields_on_a_case():
    # extra="forbid" on EvaluationCase - an unexpected field (e.g. the caller attaching raw
    # application data) must be rejected, not silently stored.
    request_body = {
        "dataset_id": "ds-1",
        "dataset_version": "v1",
        "application_id": "app-1",
        "application_version": "v1",
        "cases": [{"case_id": "c1", "answer_text": "x", "unexpected_raw_payload": {"anything": "here"}}],
    }
    client = TestClient(app)
    res = client.post("/v1/evaluations", json=request_body, headers={"x-api-key": "dev-test-key"})
    assert res.status_code == 422
