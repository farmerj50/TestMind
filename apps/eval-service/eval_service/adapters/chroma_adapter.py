"""Phase 4: ChromaDB read-only retrieval adapter. Builds `contexts`/doc-id evidence for an
EvaluationCase; never writes to any collection."""

from __future__ import annotations

from typing import Any

ADAPTER_VERSION = "0.1.0"


def retrieve_contexts(collection: Any, query_text: str, top_k: int = 5) -> dict:
    """Query a chromadb Collection (any client: ephemeral, persistent, or HTTP) read-only and
    return {retrieved_doc_ids, contexts} for merging into an EvaluationCase."""
    result = collection.query(query_texts=[query_text], n_results=top_k)
    ids = result.get("ids", [[]])[0]
    documents = result.get("documents", [[]])[0]
    return {"retrieved_doc_ids": list(ids), "contexts": list(documents)}
