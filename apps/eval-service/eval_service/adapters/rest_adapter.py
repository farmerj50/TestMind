"""Phase 4: generic REST/OpenAPI adapter.

Calls an external application over HTTP and produces one EvaluationCase-shaped dict for the
existing /v1/evaluations contract (schemas.py) - this module never imports metrics.py/gates.py
and the core evaluator never imports this module.

Includes its own SSRF-safe HTTP client. This is a Python reimplementation of the same class of
protection apps/api/src/security/http-client.ts and workflow-http.ts provide for TypeScript
callers - not a port of that code (it cannot be imported from Python), and not identical in
every detail; the goal is the same guarantee: never let this adapter be used to probe the
service's own internal network by surprise.

Known residual risk (documented, not fixed here): check_scope() resolves DNS once to validate
the target, then httpx performs its own, separate resolution when actually connecting. A DNS
answer that changes between those two lookups (DNS rebinding) is not defended against. Pinning
the resolved IP for the actual connection would close this; left out here to keep this adapter
simple, and is a reasonable target for a later hardening pass, not something to silently claim
is already handled.
"""

from __future__ import annotations

import ipaddress
import socket
from urllib.parse import urlparse

import httpx

ADAPTER_VERSION = "0.1.0"


class ScopeError(Exception):
    """Raised when a request would leave the caller-specified allowed scope."""


_PRIVATE_NETWORKS = [
    ipaddress.ip_network("127.0.0.0/8"),
    ipaddress.ip_network("10.0.0.0/8"),
    ipaddress.ip_network("172.16.0.0/12"),
    ipaddress.ip_network("192.168.0.0/16"),
    ipaddress.ip_network("169.254.0.0/16"),  # link-local, includes the 169.254.169.254 cloud metadata endpoint
    ipaddress.ip_network("::1/128"),
    ipaddress.ip_network("fc00::/7"),
    ipaddress.ip_network("fe80::/10"),
]


def _is_private_ip(host: str) -> bool:
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return False
    return any(ip in net for net in _PRIVATE_NETWORKS)


def _resolve_all(hostname: str) -> list[str]:
    try:
        infos = socket.getaddrinfo(hostname, None)
    except socket.gaierror as exc:
        raise ScopeError(f"Could not resolve host: {hostname!r}") from exc
    return [info[4][0] for info in infos]


def check_scope(url: str, allowed_hosts: list[str], *, allow_private: bool = False) -> None:
    """Raise ScopeError unless url's scheme/host is explicitly allowed and (unless
    allow_private=True) resolves to no private/link-local/loopback/metadata address. There is no
    implicit or global allowlist - the caller decides scope per call via allowed_hosts.

    allow_private defaults to False (secure by default), mirroring the existing
    apps/api/src/lib/workflow-http.ts precedent (`TM_ALLOW_PRIVATE_OUTBOUND`, also default-off) -
    an operator who deliberately wants to point this adapter at an internal/private target (e.g.
    a staging app on a corporate network, or a local test fixture) sets this explicitly; it is
    never inferred from allowed_hosts alone, since the allowlist is also what every redirect hop
    gets re-validated against regardless of this flag."""
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise ScopeError(f"Unsupported scheme: {parsed.scheme!r}")
    hostname = (parsed.hostname or "").lower()
    if not hostname:
        raise ScopeError("URL has no host")
    allowed = {h.lower() for h in allowed_hosts if h}
    if not allowed:
        raise ScopeError("allowed_hosts must be explicit and non-empty - refusing an implicit allowlist")
    if not any(hostname == h or hostname.endswith(f".{h}") for h in allowed):
        raise ScopeError(f"Host {hostname!r} is not in the allowed scope {sorted(allowed)}")
    if not allow_private:
        for ip in _resolve_all(hostname):
            if _is_private_ip(ip):
                raise ScopeError(f"Host {hostname!r} resolves to a private/link-local address ({ip}) - refused")


def call_rest_case(
    *,
    url: str,
    allowed_hosts: list[str],
    case_id: str,
    method: str = "GET",
    headers: dict[str, str] | None = None,
    json_body: dict | None = None,
    question: str | None = None,
    ground_truth: str | None = None,
    contexts: list[str] | None = None,
    answer_path: list[str] | None = None,
    allow_private: bool = False,
    max_redirects: int = 3,
    timeout: float = 10.0,
) -> dict:
    """Call an external application and return one EvaluationCase-shaped dict.

    answer_path: an optional list of keys/indices to drill into a JSON response for the answer
    text (e.g. ["choices", 0, "text"]); if omitted, the whole response body becomes answer_text.
    Re-validates scope (same allowed_hosts/allow_private) on EVERY redirect hop - never follows
    a redirect to an out-of-scope host just because the original request was in scope.
    """
    check_scope(url, allowed_hosts, allow_private=allow_private)
    current_url = url
    redirects_followed = 0
    with httpx.Client(timeout=timeout, follow_redirects=False) as client:
        while True:
            response = client.request(method, current_url, headers=headers, json=json_body)
            if response.status_code in (301, 302, 303, 307, 308):
                location = response.headers.get("location")
                if not location:
                    break
                next_url = str(httpx.URL(current_url).join(location))
                redirects_followed += 1
                if redirects_followed > max_redirects:
                    raise ScopeError("Too many redirects")
                check_scope(next_url, allowed_hosts, allow_private=allow_private)
                current_url = next_url
                continue
            break

    answer_text = ""
    try:
        data = response.json()
    except ValueError:
        data = None
        answer_text = response.text
    if data is not None:
        node = data
        if answer_path:
            for key in answer_path:
                node = node[key] if isinstance(node, dict) else node[int(key)]
        answer_text = node if isinstance(node, str) else str(node)

    return {
        "case_id": case_id,
        "question": question,
        "answer_text": answer_text,
        "ground_truth": ground_truth,
        "contexts": contexts,
    }
