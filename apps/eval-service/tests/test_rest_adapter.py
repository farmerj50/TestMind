import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from eval_service.adapters.rest_adapter import ScopeError, call_rest_case, check_scope


class _FixtureHandler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        if self.path == "/answer":
            body = b'{"choices": [{"text": "Paris is the capital of France."}]}'
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        elif self.path == "/redirect-offscope":
            self.send_response(302)
            self.send_header("Location", "http://example.invalid/internal")
            self.end_headers()
        else:
            self.send_response(404)
            self.end_headers()


@pytest.fixture()
def fixture_server():
    server = HTTPServer(("127.0.0.1", 0), _FixtureHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server.server_port
    finally:
        server.shutdown()
        thread.join(timeout=2)


def test_check_scope_rejects_empty_allowlist():
    with pytest.raises(ScopeError, match="explicit and non-empty"):
        check_scope("http://127.0.0.1:1234/x", [])


def test_check_scope_rejects_host_not_in_allowlist():
    with pytest.raises(ScopeError, match="not in the allowed scope"):
        check_scope("http://example.invalid/x", ["other.invalid"], allow_private=True)


@pytest.mark.parametrize("host", ["127.0.0.1", "10.0.0.5", "192.168.1.1", "169.254.169.254"])
def test_check_scope_rejects_private_ip_by_default_even_if_allowlisted(host):
    # Secure-by-default: an operator putting a private host on the allowlist does NOT implicitly
    # permit private-network access - they must also pass allow_private=True.
    with pytest.raises(ScopeError, match="private/link-local address"):
        check_scope(f"http://{host}:1234/x", [host])


def test_check_scope_allows_private_ip_when_explicitly_opted_in():
    check_scope("http://127.0.0.1:1234/x", ["127.0.0.1"], allow_private=True)  # must not raise


def test_check_scope_rejects_unsupported_scheme():
    with pytest.raises(ScopeError, match="Unsupported scheme"):
        check_scope("ftp://example.invalid/x", ["example.invalid"])


def test_call_rest_case_happy_path(fixture_server):
    case = call_rest_case(
        url=f"http://127.0.0.1:{fixture_server}/answer",
        allowed_hosts=["127.0.0.1"],
        allow_private=True,  # the fixture server is, unavoidably, on loopback
        case_id="c1",
        question="What is the capital of France?",
        answer_path=["choices", 0, "text"],
    )
    assert case["case_id"] == "c1"
    assert case["answer_text"] == "Paris is the capital of France."
    assert case["question"] == "What is the capital of France?"


def test_call_rest_case_refuses_redirect_to_offscope_host(fixture_server):
    # The ORIGINAL request to the fixture server is in scope (allow_private=True covers it), but
    # the redirect target is a different host never on the allowlist - must still be refused,
    # proving every hop is re-validated, not just the first request.
    with pytest.raises(ScopeError, match="not in the allowed scope"):
        call_rest_case(
            url=f"http://127.0.0.1:{fixture_server}/redirect-offscope",
            allowed_hosts=["127.0.0.1"],
            allow_private=True,
            case_id="c3",
        )
