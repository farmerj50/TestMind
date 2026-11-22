"""Tests the pgvector adapter against this repo's existing local disposable Postgres (the same
instance apps/api uses in dev) - a throwaway table is created, queried, and dropped; no real
apps/api table is touched. The connection string is read directly from apps/api/.env by this
fixture (same mechanism the real app uses) and is never printed or logged anywhere."""

from __future__ import annotations

import os
import re
from pathlib import Path

import psycopg2
import pytest

from eval_service.adapters.pgvector_adapter import ADAPTER_VERSION, retrieve_contexts


def _read_database_url() -> str | None:
    env_path = Path(__file__).resolve().parents[2] / "api" / ".env"
    if not env_path.exists():
        return None
    for line in env_path.read_text(encoding="utf-8").splitlines():
        match = re.match(r"^DATABASE_URL=([^#]+)", line.strip())
        if match:
            return match.group(1).strip()
    return None


def _pgvector_available(dsn: str) -> bool:
    try:
        conn = psycopg2.connect(dsn)
        with conn.cursor() as cur:
            cur.execute("SELECT 1 FROM pg_extension WHERE extname = 'vector'")
            has_ext = cur.fetchone() is not None
        conn.close()
        return has_ext
    except Exception:
        return False


_DSN = _read_database_url()
_SKIP_REASON = None
if not _DSN:
    _SKIP_REASON = "DATABASE_URL not found in apps/api/.env"
elif not _pgvector_available(_DSN):
    _SKIP_REASON = "local Postgres unreachable or missing the 'vector' extension"

pytestmark = pytest.mark.skipif(_SKIP_REASON is not None, reason=_SKIP_REASON or "")


def test_adapter_version_is_set():
    assert ADAPTER_VERSION


@pytest.fixture()
def throwaway_table():
    table = "eval_service_phase4_test_docs"
    conn = psycopg2.connect(_DSN)
    conn.autocommit = True
    with conn.cursor() as cur:
        cur.execute(f"DROP TABLE IF EXISTS {table}")
        cur.execute(f"CREATE TABLE {table} (id text, content text, embedding vector(3))")
        cur.execute(
            f"INSERT INTO {table} (id, content, embedding) VALUES "
            "('doc-1', 'Paris is the capital of France.', '[1,0,0]'), "
            "('doc-2', 'Berlin is the capital of Germany.', '[0.9,0.1,0]'), "
            "('doc-3', 'Unrelated text.', '[0,0,1]')"
        )
    try:
        yield table
    finally:
        with conn.cursor() as cur:
            cur.execute(f"DROP TABLE IF EXISTS {table}")
        conn.close()


def test_retrieve_contexts_against_real_local_postgres(throwaway_table):
    result = retrieve_contexts(_DSN, query_vector=[1.0, 0.0, 0.0], table=throwaway_table, top_k=2)
    assert result["retrieved_doc_ids"][0] == "doc-1"
    assert "Paris" in result["contexts"][0]
    assert len(result["retrieved_doc_ids"]) == 2


def test_retrieve_contexts_rejects_invalid_identifier():
    with pytest.raises(ValueError):
        retrieve_contexts(_DSN, query_vector=[1.0], table="docs; DROP TABLE users")
