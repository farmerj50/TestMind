import faiss
import numpy as np

from eval_service.adapters.faiss_adapter import ADAPTER_VERSION, retrieve_contexts


def test_adapter_version_is_set():
    assert ADAPTER_VERSION


def test_retrieve_contexts_against_real_faiss_index():
    dim = 4
    vectors = np.array(
        [
            [1.0, 0.0, 0.0, 0.0],
            [0.0, 1.0, 0.0, 0.0],
            [0.0, 0.0, 1.0, 0.0],
        ],
        dtype="float32",
    )
    index = faiss.IndexFlatL2(dim)
    index.add(vectors)
    doc_table = [("doc-1", "Paris content"), ("doc-2", "Berlin content"), ("doc-3", "Unrelated content")]

    query_vector = np.array([[0.95, 0.05, 0.0, 0.0]], dtype="float32")
    result = retrieve_contexts(index, query_vector, doc_table, top_k=2)

    assert result["retrieved_doc_ids"][0] == "doc-1"
    assert result["contexts"][0] == "Paris content"
    assert len(result["retrieved_doc_ids"]) == 2
