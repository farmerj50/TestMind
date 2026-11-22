"""x-api-key authentication for POST /v1/evaluations. Not wired onto /healthz, which must stay
unauthenticated for platform health checks (Railway or any other host)."""
from __future__ import annotations

import os
import secrets

from fastapi import Header, HTTPException


def require_api_key(x_api_key: str = Header(...)) -> None:
    expected = os.environ.get("TESTMIND_EVAL_API_KEY")
    if not expected:
        # Fail closed: an unconfigured server must refuse every request, not silently accept
        # any key (or none).
        raise HTTPException(status_code=500, detail="TESTMIND_EVAL_API_KEY is not configured on this server.")
    # Constant-time comparison - a plain != leaks timing information proportional to the
    # number of matching leading characters, letting a remote attacker recover the key
    # byte-by-byte via repeated timed requests.
    if not secrets.compare_digest(x_api_key, expected):
        raise HTTPException(status_code=401, detail="Invalid API key.")
