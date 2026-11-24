# TestMind AI Evaluation Engine - standalone service.
#
# Phase 5 hardening. This is a long-running HTTP SERVICE (receives requests, calls out to
# caller-chosen LLM/vector-store providers) - not a per-invocation sandboxed script executor
# like apps/api/src/runner/python-sandbox/, so that sandbox's model doesn't transfer directly:
#   - NetworkMode=none is deliberately NOT applied here (unlike python-sandbox) - this service
#     needs real outbound network access to do its job (LLM providers, vector stores, the
#     caller's own application for the REST adapter). The REST adapter's check_scope()
#     allowlist (Phase 4) is this service's equivalent network-restriction control, enforced in
#     application code rather than at the container's network layer.
#   - cap-drop, no-new-privileges, pids/memory limits, and read-only-root are all `docker run` /
#     compose / k8s SecurityContext flags, not Dockerfile directives - python-sandbox's
#     equivalents are applied programmatically per-container by apps/api/src/runner/
#     pytest-sandbox.ts, which constructs that `docker run` call itself. Nothing in this repo
#     currently constructs the `docker run`/deploy invocation for THIS service (Phase 1's own
#     plan notes Railway deployment is manual) - so the required flags are documented below for
#     whoever deploys it (Railway / compose / k8s) to apply, since a Dockerfile has no syntax to
#     enforce them itself:
#       --read-only --tmpfs /tmp:rw,noexec,nosuid,size=64m
#       --cap-drop=ALL --security-opt=no-new-privileges=true
#       --pids-limit=128 --memory=512m --memory-swap=512m
#
# Base image pinned to a specific digest (not the floating `python:3.12-slim` tag), resolved
# and recorded 2026-11-22. Unlike python-sandbox's ephemeral per-invocation containers, this
# image isn't re-pulled on every request, so the runtime digest-re-verification logic in
# pytest-sandbox.ts doesn't apply here - pinning at build time is the correct, sufficient
# control for a long-running service image.
FROM python:3.12-slim@sha256:5e2bdb1b0d542d5039cffb8181c65930093949194a65c365dfb1b0fe13a4fa5b

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY eval_service ./eval_service

RUN useradd -m -u 10001 appuser && chown -R appuser:appuser /app
USER appuser

ENV PORT=8080
EXPOSE 8080

CMD ["sh", "-c", "uvicorn eval_service.main:app --host 0.0.0.0 --port ${PORT}"]
