# TestMind AI Evaluation Engine — standalone service

**Scope:** standalone, API-key-protected Python FastAPI evaluation service, integrated as a
*separate* process from TestMind's Fastify backend. This is a **prototype**, not a
bank-certified production deployment.

## Features implemented

- Typed REST evaluation contract and authenticated `/v1/evaluations` endpoint
- Deterministic document Recall@k, Precision@k, required-fact *substring smoke check*,
  abstention checks, and p95 latency
- Versioned dataset/application identifiers, configurable quality gates, pytest examples,
  Dockerfile
- No dependency on LangChain: any system can POST completed evaluation cases

## Install and test

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements-dev.txt
pytest -q
export TESTMIND_EVAL_API_KEY=dev-test-key
uvicorn eval_service.main:app --host 127.0.0.1 --port 8080
```

In another terminal:

```bash
curl -X POST http://127.0.0.1:8080/v1/evaluations \
  -H 'Content-Type: application/json' \
  -H 'x-api-key: dev-test-key' \
  --data-binary @examples/golden_dataset.json
```

## TestMind integration

This service is called from TestMind's Fastify backend over HTTP from a BullMQ worker, using a
shared-secret `x-api-key` header, and its results are persisted via Prisma. See the repository's
Evaluation Engine master plan for the full integration architecture, the workflow-engine
integration slot (Phase 2), real RAG/LLM evaluation via Ragas/DeepEval (Phase 3), external
adapters (Phase 4), and the enterprise security/reliability hardening required before any of
this is production-ready (Phase 5). This service itself stays independently testable and
deployable throughout — none of those phases should ever make it depend on the rest of the
monorepo to run its own test suite.

## Current limitations

`required_fact_rate` is a **literal substring smoke check**. It does not implement semantic
evaluation, factual correctness, or full RAG groundedness. `abstained` is supplied by the caller
and should be verified from source evidence in future iterations. The API processes input
synchronously and has no persistence, queue, tenant RBAC, tracing, or live LLM connections
inside this service itself (TestMind's side owns persistence/queueing). Do **not** describe
these as implemented.

## Production hardening required

Not implemented yet, and required before this is production-ready (see the master plan's Phase
5): internal-only network / mTLS or workload identity; rotated and scoped secrets; per-project
authorization and tenant isolation on the TestMind side; PII redaction in prompts/retrieved
contexts/traces; audit logs and retention/deletion policies; immutable dataset/evaluator
versioning with idempotent jobs, retries, cancellation, quotas, and timeouts; signed artifact
retention; CI quality gates; outbound allowlisting for any future adapter that fetches a URL;
LLM-as-judge factuality/faithfulness calibrated by human reviewers; statistical guardrails
against small datasets and model-evaluator variance.
