"""Phase 4: FAISS read-only retrieval adapter. FAISS itself only does nearest-neighbor search
over vectors - it has no notion of document text - so the caller supplies a query embedding and
a side-table mapping each index position to (doc_id, content). Never writes to the index."""

from __future__ import annotations

ADAPTER_VERSION = "0.1.0"


def retrieve_contexts(index, query_vector, doc_table: list[tuple[str, str]], top_k: int = 5) -> dict:
    """`index`: a faiss.Index already built/loaded by the caller.
    `query_vector`: a 2D numpy array of shape (1, dim) matching the index's dimensionality.
    `doc_table`: list of (doc_id, content) in the same order the vectors were added to the index.
    """
    distances, positions = index.search(query_vector, top_k)
    doc_ids: list[str] = []
    contexts: list[str] = []
    for position in positions[0]:
        if position < 0 or position >= len(doc_table):
            continue
        doc_id, content = doc_table[position]
        doc_ids.append(doc_id)
        contexts.append(content)
    return {"retrieved_doc_ids": doc_ids, "contexts": contexts}
