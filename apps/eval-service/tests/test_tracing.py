from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

from eval_service.adapters.tracing import ADAPTER_VERSION, traced_evaluation


def test_adapter_version_is_set():
    assert ADAPTER_VERSION


def test_no_op_when_neither_tracer_nor_client_supplied():
    ran = False
    with traced_evaluation("eval-run"):
        ran = True
    assert ran  # the wrapped code still executes - tracing being absent never blocks anything


def test_real_otel_span_is_created_when_enabled():
    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    tracer = provider.get_tracer("phase4-test")

    with traced_evaluation("eval-run", attributes={"dataset_id": "ds-1"}, otel_tracer=tracer):
        pass

    spans = exporter.get_finished_spans()
    assert len(spans) == 1
    assert spans[0].name == "eval-run"
    assert spans[0].attributes["dataset_id"] == "ds-1"


def test_is_a_silent_no_op_when_the_supplied_client_is_broken():
    # Simulates "langsmith/otel installed but misconfigured/unreachable" - must never raise,
    # and the wrapped code must still run. This is the "additive only" contract: tracing failing
    # is never allowed to fail the evaluation itself.
    class _BrokenTracer:
        def start_as_current_span(self, *args, **kwargs):
            raise RuntimeError("no real exporter configured")

    ran = False
    with traced_evaluation("eval-run", otel_tracer=_BrokenTracer()):
        ran = True
    assert ran


def test_is_a_silent_no_op_when_langsmith_client_is_unusable():
    class _BrokenLangsmithClient:
        pass  # langsmith_trace() will fail against this - no real credential/network involved

    ran = False
    with traced_evaluation("eval-run", langsmith_client=_BrokenLangsmithClient()):
        ran = True
    assert ran
