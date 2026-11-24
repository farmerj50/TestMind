"""Phase 4: LangChain / LangGraph trace adapter.

Translates a LangChain Runnable's trace or a LangGraph StateGraph's final/intermediate state
into EvaluationCase-shaped dicts for the existing /v1/evaluations contract. Never imports
metrics.py/gates.py.
"""

from __future__ import annotations

from typing import Any

ADAPTER_VERSION = "0.1.0"


def case_from_runnable_result(
    *,
    case_id: str,
    inputs: dict[str, Any],
    output: Any,
    question_key: str = "question",
    answer_key: str | None = None,
    ground_truth: str | None = None,
    contexts: list[str] | None = None,
) -> dict:
    """Build one case from a LangChain Runnable's `.invoke()` input/output pair.

    `output` may be a plain string, or a dict/BaseMessage-like object with `.content`;
    `answer_key`, if given, drills into a dict output for the answer field.
    """
    question = inputs.get(question_key) if isinstance(inputs, dict) else None

    if answer_key is not None and isinstance(output, dict):
        answer = output.get(answer_key)
    elif hasattr(output, "content"):
        answer = output.content  # LangChain BaseMessage-style output
    else:
        answer = output

    return {
        "case_id": case_id,
        "question": question if isinstance(question, str) else None,
        "answer_text": answer if isinstance(answer, str) else str(answer),
        "ground_truth": ground_truth,
        "contexts": contexts,
    }


def cases_from_langgraph_state(
    *,
    case_id: str,
    final_state: dict[str, Any],
    question_field: str = "question",
    answer_field: str = "answer",
    contexts_field: str | None = "contexts",
    ground_truth: str | None = None,
) -> dict:
    """Build one case from a LangGraph StateGraph's final state dict (the object returned by
    `graph.invoke(...)`). Fields default to the conventional `question`/`answer`/`contexts` keys
    but are configurable since graph state shape is entirely application-defined."""
    question = final_state.get(question_field)
    answer = final_state.get(answer_field)
    contexts = final_state.get(contexts_field) if contexts_field else None

    return {
        "case_id": case_id,
        "question": question if isinstance(question, str) else None,
        "answer_text": answer if isinstance(answer, str) else ("" if answer is None else str(answer)),
        "ground_truth": ground_truth,
        "contexts": contexts if isinstance(contexts, list) else None,
    }
