"""Phase 4 acceptance gate (per the master plan): a real LangGraph integration and an
independent REST-application integration must each be demonstrated with passing end-to-end
tests, not unit tests against a fixture alone. Both tests here run adapter output through the
REAL /v1/evaluations endpoint (via FastAPI's TestClient, same as the rest of this suite) and
assert a correctly-computed response - not just that the adapter's own intermediate output
looks right in isolation."""

import os
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import TypedDict

import pytest
from fastapi.testclient import TestClient
from langgraph.graph import StateGraph

os.environ["TESTMIND_EVAL_API_KEY"] = "dev-test-key"

from eval_service.adapters.langchain_adapter import cases_from_langgraph_state  # noqa: E402
from eval_service.adapters.rest_adapter import call_rest_case  # noqa: E402
from eval_service.main import app  # noqa: E402


@pytest.fixture()
def client():
    return TestClient(app)


class _GraphState(TypedDict):
    question: str
    contexts: list[str]
    answer: str


def _retrieve(state: _GraphState) -> _GraphState:
    return {**state, "contexts": ["France's capital city is Paris."]}


def _answer(state: _GraphState) -> _GraphState:
    return {**state, "answer": "Based on the retrieved facts, the capital of France is Paris."}


def test_langgraph_adapter_output_through_real_eval_endpoint(client):
    graph_builder = StateGraph(_GraphState)
    graph_builder.add_node("retrieve", _retrieve)
    graph_builder.add_node("answer", _answer)
    graph_builder.set_entry_point("retrieve")
    graph_builder.add_edge("retrieve", "answer")
    graph_builder.set_finish_point("answer")
    graph = graph_builder.compile()

    final_state = graph.invoke({"question": "What is the capital of France?", "contexts": [], "answer": ""})
    case = cases_from_langgraph_state(case_id="lg-e2e-1", final_state=final_state, contexts_field=None)
    case["required_facts"] = ["Paris"]

    request_body = {
        "dataset_id": "phase4-langgraph-e2e",
        "dataset_version": "v1",
        "application_id": "phase4-langgraph-app",
        "application_version": "v1",
        "gates": {"required_fact_rate": {"min": 1.0}},
        "cases": [case],
    }
    res = client.post("/v1/evaluations", json=request_body, headers={"x-api-key": "dev-test-key"})
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["overall_gate_status"] == "pass"
    assert body["case_results"][0]["case_id"] == "lg-e2e-1"
    assert body["case_results"][0]["required_fact_rate"] == 1.0


class _RestFixtureHandler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        if self.path == "/answer":
            body = b'{"answer": "The capital of France is Paris."}'
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_response(404)
            self.end_headers()


@pytest.fixture()
def rest_fixture_server():
    server = HTTPServer(("127.0.0.1", 0), _RestFixtureHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server.server_port
    finally:
        server.shutdown()
        thread.join(timeout=2)


def test_rest_adapter_output_through_real_eval_endpoint(client, rest_fixture_server):
    case = call_rest_case(
        url=f"http://127.0.0.1:{rest_fixture_server}/answer",
        allowed_hosts=["127.0.0.1"],
        allow_private=True,
        case_id="rest-e2e-1",
        question="What is the capital of France?",
        answer_path=["answer"],
    )
    case["required_facts"] = ["Paris"]

    request_body = {
        "dataset_id": "phase4-rest-e2e",
        "dataset_version": "v1",
        "application_id": "phase4-rest-app",
        "application_version": "v1",
        "gates": {"required_fact_rate": {"min": 1.0}},
        "cases": [case],
    }
    res = client.post("/v1/evaluations", json=request_body, headers={"x-api-key": "dev-test-key"})
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["overall_gate_status"] == "pass"
    assert body["case_results"][0]["case_id"] == "rest-e2e-1"
    assert body["case_results"][0]["required_fact_rate"] == 1.0
