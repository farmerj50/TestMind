from langchain_core.runnables import RunnableLambda
from langgraph.graph import StateGraph
from typing import TypedDict

from eval_service.adapters.langchain_adapter import (
    ADAPTER_VERSION,
    case_from_runnable_result,
    cases_from_langgraph_state,
)


def test_adapter_version_is_set():
    assert ADAPTER_VERSION


def test_case_from_runnable_result_with_real_langchain_runnable():
    # A real, deterministic LangChain Runnable - no LLM call needed.
    chain = RunnableLambda(lambda inputs: f"The answer is: {inputs['question'][::-1]}")
    inputs = {"question": "olleh"}
    output = chain.invoke(inputs)

    case = case_from_runnable_result(
        case_id="rc-1",
        inputs=inputs,
        output=output,
        ground_truth="The answer is: hello",
    )
    assert case["case_id"] == "rc-1"
    assert case["question"] == "olleh"
    assert case["answer_text"] == "The answer is: hello"
    assert case["ground_truth"] == "The answer is: hello"


class _GraphState(TypedDict):
    question: str
    contexts: list[str]
    answer: str


def _retrieve(state: _GraphState) -> _GraphState:
    return {**state, "contexts": [f"Fact about {state['question']}"]}


def _answer(state: _GraphState) -> _GraphState:
    return {**state, "answer": f"Answer referencing {state['contexts'][0]}"}


def test_cases_from_real_langgraph_state():
    # A real, deterministic LangGraph StateGraph with plain Python node functions - no LLM call.
    graph_builder = StateGraph(_GraphState)
    graph_builder.add_node("retrieve", _retrieve)
    graph_builder.add_node("answer", _answer)
    graph_builder.set_entry_point("retrieve")
    graph_builder.add_edge("retrieve", "answer")
    graph_builder.set_finish_point("answer")
    graph = graph_builder.compile()

    final_state = graph.invoke({"question": "FastAPI", "contexts": [], "answer": ""})

    case = cases_from_langgraph_state(case_id="lg-1", final_state=final_state)
    assert case["case_id"] == "lg-1"
    assert case["question"] == "FastAPI"
    assert case["contexts"] == ["Fact about FastAPI"]
    assert "Fact about FastAPI" in case["answer_text"]
