"""Phase 4: optional LangSmith + OpenTelemetry tracing around an evaluation call.

Unlike DeepEval (Phase 3), which fails closed when a caller actually requests a DeepEval metric
it can't run, tracing is explicitly additive-only per the master plan: a missing or unavailable
library here must be a silent no-op, never a failure, since nothing about the core evaluation
result depends on whether a trace was emitted. Both integrations are optional-import-guarded at
call time (not at module import time), so importing this module never fails even with neither
package installed.
"""

from __future__ import annotations

from contextlib import contextmanager
from typing import Any, Iterator

ADAPTER_VERSION = "0.1.0"


@contextmanager
def traced_evaluation(
    name: str,
    *,
    attributes: dict[str, Any] | None = None,
    langsmith_client: Any | None = None,
    otel_tracer: Any | None = None,
) -> Iterator[None]:
    """Wrap an evaluation call in a LangSmith run and/or an OpenTelemetry span, if available and
    enabled. `langsmith_client`/`otel_tracer` are caller-supplied (never constructed here from
    service-level env vars/config) so this stays additive and testable without real credentials.
    If neither is supplied, or the underlying library import fails, this is a plain no-op."""
    otel_span_cm = None
    langsmith_run_cm = None

    if otel_tracer is not None:
        try:
            otel_span_cm = otel_tracer.start_as_current_span(name, attributes=attributes or {})
        except Exception:
            otel_span_cm = None

    if langsmith_client is not None:
        try:
            from langsmith.run_helpers import trace as langsmith_trace

            langsmith_run_cm = langsmith_trace(name=name, client=langsmith_client, inputs=attributes or {})
        except Exception:
            langsmith_run_cm = None

    try:
        if otel_span_cm is not None:
            with otel_span_cm:
                if langsmith_run_cm is not None:
                    with langsmith_run_cm:
                        yield
                else:
                    yield
        elif langsmith_run_cm is not None:
            with langsmith_run_cm:
                yield
        else:
            yield
    except Exception:
        raise
