import chromadb

from eval_service.adapters.chroma_adapter import ADAPTER_VERSION, retrieve_contexts


def test_adapter_version_is_set():
    assert ADAPTER_VERSION


def test_retrieve_contexts_against_real_ephemeral_chroma_collection():
    # EphemeralClient needs no server; a collection created with no explicit embedding function
    # uses chromadb's own default one, which is what makes a text query_texts() call work.
    client = chromadb.EphemeralClient()
    collection = client.create_collection("phase4-test")
    collection.add(
        ids=["doc-1", "doc-2"],
        documents=["Paris is the capital of France.", "Completely unrelated text about cooking pasta."],
    )

    result = retrieve_contexts(collection, "capital of France", top_k=1)
    assert result["retrieved_doc_ids"] == ["doc-1"]
    assert result["contexts"] == ["Paris is the capital of France."]
