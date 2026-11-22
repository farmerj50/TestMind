"""Protocol/contract test only - no real Pinecone service or credential is available in this
environment. Verifies the adapter correctly consumes Pinecone's documented query-response
shape against a hand-written fake client, not against the real service."""

from eval_service.adapters.pinecone_adapter import ADAPTER_VERSION, retrieve_contexts


def test_adapter_version_is_set():
    assert ADAPTER_VERSION


class _FakePineconeIndex:
    def __init__(self, matches):
        self._matches = matches

    def query(self, *, vector, top_k, include_metadata):
        assert include_metadata is True
        return {"matches": self._matches[:top_k]}


def test_retrieve_contexts_against_documented_pinecone_response_shape():
    index = _FakePineconeIndex(
        [
            {"id": "doc-1", "score": 0.95, "metadata": {"text": "Paris is the capital of France."}},
            {"id": "doc-2", "score": 0.80, "metadata": {"text": "Berlin is the capital of Germany."}},
        ]
    )

    result = retrieve_contexts(index, query_vector=[0.1, 0.2, 0.3], top_k=1)
    assert result["retrieved_doc_ids"] == ["doc-1"]
    assert result["contexts"] == ["Paris is the capital of France."]


def test_retrieve_contexts_handles_missing_metadata_key_gracefully():
    index = _FakePineconeIndex([{"id": "doc-1", "metadata": {}}])
    result = retrieve_contexts(index, query_vector=[0.1], top_k=1)
    assert result["retrieved_doc_ids"] == ["doc-1"]
    assert result["contexts"] == [""]
