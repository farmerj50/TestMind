"""Extension point for optional adapter modules (LangChain/LangGraph, Ragas, DeepEval,
LangSmith, OpenTelemetry - see Phase 3/4 of the master plan). No concrete adapter is wired in
yet; this package intentionally has no runtime behavior in Phase 1. Do not import application
frameworks into eval_service.main/metrics/gates - adapters are additive, never a dependency of
the core evaluator."""
