"""Builds the ragas-compatible LLM/embeddings clients used for semantic (Phase 3) metrics.

Fail-closed discipline: if any case actually requests semantic evaluation (sets `contexts`
and/or `ground_truth`) but the request carries no `llm_api_key`, this raises - the caller gets a
clear 400, never a silent skip of paid/semantic work. If no case requests it, `build_judge`
is never called at all and the deterministic-only path is completely unaffected.

The API key is never logged or included in any exception message raised from this module.
"""
from __future__ import annotations

from dataclasses import dataclass

from openai import AsyncOpenAI
from ragas.embeddings import OpenAIEmbeddings
from ragas.llms import llm_factory
from ragas.llms.base import InstructorBaseRagasLLM


class SemanticEvaluationNotConfigured(Exception):
    """Raised when a case requests semantic evaluation but no llm_api_key was supplied."""


@dataclass
class Judge:
    llm: InstructorBaseRagasLLM
    embeddings: OpenAIEmbeddings
    llm_model: str
    embedding_model: str


def case_requests_semantic_evaluation(cases: list) -> bool:
    return any(case.contexts or case.ground_truth for case in cases)


def build_judge(llm_api_key: str | None, llm_model: str, embedding_model: str) -> Judge:
    if not llm_api_key:
        raise SemanticEvaluationNotConfigured(
            "One or more cases set 'contexts' or 'ground_truth', which requests semantic "
            "evaluation, but no llm_api_key was supplied on the request."
        )
    client = AsyncOpenAI(api_key=llm_api_key)
    llm = llm_factory(model=llm_model, provider="openai", client=client)
    embeddings = OpenAIEmbeddings(client=client, model=embedding_model)
    return Judge(llm=llm, embeddings=embeddings, llm_model=llm_model, embedding_model=embedding_model)
