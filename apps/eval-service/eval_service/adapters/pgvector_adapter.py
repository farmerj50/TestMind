"""Phase 4: pgvector read-only retrieval adapter. The eval-service has no database connectivity
of its own - the caller always supplies the connection string per call (never read from an
eval-service env var). Read-only: issues a SELECT against a caller-named table shaped
(id, embedding, content); never writes."""

from __future__ import annotations

import psycopg2

ADAPTER_VERSION = "0.1.0"


def retrieve_contexts(
    connection_string: str,
    query_vector: list[float],
    table: str,
    top_k: int = 5,
    id_column: str = "id",
    embedding_column: str = "embedding",
    content_column: str = "content",
) -> dict:
    """Connects read-only, runs one pgvector cosine-distance ORDER BY/LIMIT query, disconnects.
    `table`/column names are validated as simple identifiers before being interpolated into SQL
    (parameterized queries can't carry identifiers) - never pass caller-untrusted table/column
    names without that check happening first."""
    for identifier in (table, id_column, embedding_column, content_column):
        if not identifier.replace("_", "").isalnum():
            raise ValueError(f"Invalid SQL identifier: {identifier!r}")

    vector_literal = "[" + ",".join(repr(float(v)) for v in query_vector) + "]"
    query = (
        f"SELECT {id_column}, {content_column} FROM {table} "
        f"ORDER BY {embedding_column} <-> %s::vector LIMIT %s"
    )
    conn = psycopg2.connect(connection_string)
    try:
        conn.set_session(readonly=True)
        with conn.cursor() as cur:
            cur.execute(query, (vector_literal, top_k))
            rows = cur.fetchall()
    finally:
        conn.close()

    return {
        "retrieved_doc_ids": [str(row[0]) for row in rows],
        "contexts": [str(row[1]) for row in rows],
    }
