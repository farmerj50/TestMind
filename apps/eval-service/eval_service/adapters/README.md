# Adapters (Phase 4: external integrations)

Every adapter in this directory has exactly one job: translate its own input shape into
`cases[]` for the existing `EvaluationRequest`/`EvaluationCase` contract (`eval_service/schemas.py`).
None of them is imported by `main.py`, `metrics.py`, or `gates.py`, and none of them requires a
change to those modules to add - that's what "adding an adapter never touches core logic" means
here, verified by construction (check any adapter module's imports).

Each adapter exports an `ADAPTER_VERSION` string constant.

## `langchain_adapter.py` (v0.1.0)

- `case_from_runnable_result(...)`: builds one case from a LangChain `Runnable`'s input/output.
- `cases_from_langgraph_state(...)`: builds one case from a LangGraph `StateGraph`'s final state
  dict. Field names (`question_field`/`answer_field`/`contexts_field`) are configurable since
  graph state shape is entirely application-defined; pass `contexts_field=None` to omit contexts
  (e.g. when you only want deterministic metrics and no semantic-evaluation fail-closed check).

## `rest_adapter.py` (v0.1.0) - authorization / SSRF model

`call_rest_case(...)` calls an external application over HTTP. Its SSRF protection:

- **Explicit allowlist, no implicit default.** `allowed_hosts` is required and non-empty; there
  is no global/implicit scope.
- **Private/link-local/loopback/metadata addresses are refused by default.** Set
  `allow_private=True` to deliberately point this adapter at an internal/private target (e.g. a
  staging app, or a local test fixture) - this mirrors the existing
  `apps/api/src/lib/workflow-http.ts` precedent (`TM_ALLOW_PRIVATE_OUTBOUND`, also default-off).
  Putting a private host on `allowed_hosts` does **not** implicitly grant this.
- **Every redirect hop is re-validated** against the same `allowed_hosts`/`allow_private` - a
  3xx response whose `Location` points outside scope is refused, not followed.
- **Known residual risk, not fixed**: scope is checked via one DNS resolution; the actual HTTP
  connection resolves again independently. A DNS answer that changes between those two lookups
  (DNS rebinding) is not defended against. Pinning the resolved IP for the connection itself would
  close this and is a reasonable target for a later hardening pass.

This is a Python reimplementation of the same class of protection
`apps/api/src/security/http-client.ts`/`workflow-http.ts` provide for TypeScript callers - not a
port of that code, and not identical in every detail.

## Vector-retrieval adapters (read-only; none ever writes to a store)

- **`chroma_adapter.py`** (v0.1.0): `chromadb` ephemeral/in-memory or any real client - tested
  against a real local ephemeral collection.
- **`faiss_adapter.py`** (v0.1.0): `faiss-cpu` - tested against a real local `IndexFlatL2`.
  Caller supplies the query embedding and a `(doc_id, content)` side-table; FAISS itself has no
  notion of document text.
- **`pinecone_adapter.py`** (v0.1.0): **protocol/contract module, not integration-tested against
  the real service** - no Pinecone credential is available in this environment. Duck-typed
  against any object exposing `.query(vector=..., top_k=..., include_metadata=...)`; has no hard
  dependency on the `pinecone` package. Tested against a hand-written fake client matching
  Pinecone's documented response shape.
- **`pgvector_adapter.py`** (v0.1.0): takes the connection string as a parameter on every call -
  never reads one from an eval-service env var. Table/column names are validated as plain
  identifiers before being interpolated into SQL (parameterized queries can't carry identifiers).
  Tested against this repo's own local disposable Postgres with a throwaway table, created and
  dropped by the test itself; skipped automatically (not failed) if that Postgres doesn't have
  the `vector` extension installed - confirmed absent at the time this adapter was built.

## `tracing.py` (v0.1.0) - LangSmith + OpenTelemetry

`traced_evaluation(...)` wraps a call in an OTel span and/or a LangSmith run, **both optional and
additive-only**: a missing library, an unsupplied client/tracer, or a client that raises is always
a silent no-op - tracing failing must never fail the evaluation itself. This differs from Phase
3's DeepEval integration, which fails closed when a DeepEval metric is actually requested but the
library is unavailable; tracing has no such "actually requested" state to fail closed on, so it
stays no-op by design. Both `langsmith_client`/`otel_tracer` are caller-supplied, never
constructed from service-level env vars/config.
