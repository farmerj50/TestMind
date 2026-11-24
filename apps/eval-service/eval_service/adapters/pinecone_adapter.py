"""Phase 4: Pinecone read-only retrieval adapter.

No real Pinecone credential is available in this environment. This module is written against
Pinecone's documented query-response shape and is duck-typed against any object exposing a
`.query(vector=..., top_k=..., include_metadata=...) -> {"matches": [...]}` method - it does not
import the `pinecone` package, so it has no hard dependency on it and is a protocol/contract
module: tested against a hand-written fake client, not a real Pinecone service. Treat this as
verified against the documented contract shape, not as an integration test against the real
service.
"""

from __future__ import annotations

from typing import Any, Protocol


ADAPTER_VERSION = "0.1.0"


class PineconeIndexLike(Protocol):
    def query(self, *, vector: list[float], top_k: int, include_metadata: bool) -> dict[str, Any]: ...


def retrieve_contexts(
    index: PineconeIndexLike,
    query_vector: list[float],
    top_k: int = 5,
    content_metadata_key: str = "text",
) -> dict:
    """Query a Pinecone-like index read-only. Expects each match to have `id` and, if
    `include_metadata=True`, a `metadata` dict containing `content_metadata_key`."""
    response = index.query(vector=query_vector, top_k=top_k, include_metadata=True)
    matches = response.get("matches", [])
    doc_ids: list[str] = []
    contexts: list[str] = []
    for match in matches:
        doc_ids.append(match.get("id", ""))
        metadata = match.get("metadata") or {}
        contexts.append(str(metadata.get(content_metadata_key, "")))
    return {"retrieved_doc_ids": doc_ids, "contexts": contexts}
