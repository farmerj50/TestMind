"""Typed request/response contract for POST /v1/evaluations.

Data-minimization correction (Phase 1): every field that could carry arbitrary caller/
application data (case lists, fact lists, answer text) is explicitly size-capped here at the
validation layer, not left unbounded - this service must not become a place to store or log
unbounded application data.
"""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

EVALUATOR_VERSION = "0.2.0"

MAX_CASES_PER_REQUEST = 2_000
MAX_DOC_IDS_PER_CASE = 200
MAX_REQUIRED_FACTS_PER_CASE = 50
MAX_ANSWER_TEXT_CHARS = 20_000
MAX_FACT_CHARS = 2_000
MAX_IDENTIFIER_CHARS = 200

# Phase 3: semantic (Ragas/DeepEval) fields. Capped the same way as every other field a caller
# might attach - these can carry real retrieved-passage text, so they get the same data-
# minimization discipline as answer_text, not an unbounded exception.
MAX_QUESTION_CHARS = 2_000
MAX_CONTEXTS_PER_CASE = 50
MAX_CONTEXT_CHARS = 4_000
MAX_GROUND_TRUTH_CHARS = 20_000


class GateThreshold(BaseModel):
    """A single metric's configurable quality gate. `k` applies to the @k metrics; `min`/`max`
    are the pass/fail threshold (a metric only ever declares one of the two)."""

    k: int | None = Field(default=None, ge=1, le=1000)
    min: float | None = None
    max: float | None = None


class EvaluationCase(BaseModel):
    case_id: str = Field(..., max_length=MAX_IDENTIFIER_CHARS)
    retrieved_doc_ids: list[str] = Field(default_factory=list, max_length=MAX_DOC_IDS_PER_CASE)
    relevant_doc_ids: list[str] = Field(default_factory=list, max_length=MAX_DOC_IDS_PER_CASE)
    required_facts: list[str] = Field(default_factory=list, max_length=MAX_REQUIRED_FACTS_PER_CASE)
    answer_text: str = Field(default="", max_length=MAX_ANSWER_TEXT_CHARS)
    should_abstain: bool = False
    abstained: bool = False
    latency_ms: float | None = Field(default=None, ge=0)

    # Phase 3: optional semantic-evaluation fields. Fully optional, no default behavior change -
    # a case that never sets these is byte-identical to a Phase 1 case for every deterministic
    # metric, and simply never becomes applicable to any Ragas/DeepEval metric.
    question: str | None = Field(default=None, max_length=MAX_QUESTION_CHARS)
    contexts: list[str] | None = Field(default=None, max_length=MAX_CONTEXTS_PER_CASE)
    ground_truth: str | None = Field(default=None, max_length=MAX_GROUND_TRUTH_CHARS)

    # Reject unknown fields rather than silently accepting/storing arbitrary extra
    # application data the caller might attach (data minimization).
    model_config = ConfigDict(extra="forbid")

    @field_validator("contexts")
    @classmethod
    def _cap_each_context_length(cls, value: list[str] | None) -> list[str] | None:
        # list max_length only bounds the number of items - each passage's own length needs its
        # own cap too, same data-minimization discipline as every other text field here.
        if value is not None:
            for passage in value:
                if len(passage) > MAX_CONTEXT_CHARS:
                    raise ValueError(f"each context entry must be at most {MAX_CONTEXT_CHARS} characters")
        return value


class EvaluationRequest(BaseModel):
    dataset_id: str = Field(..., min_length=1, max_length=MAX_IDENTIFIER_CHARS)
    dataset_version: str = Field(..., min_length=1, max_length=MAX_IDENTIFIER_CHARS)
    application_id: str = Field(..., min_length=1, max_length=MAX_IDENTIFIER_CHARS)
    application_version: str = Field(..., min_length=1, max_length=MAX_IDENTIFIER_CHARS)
    gates: dict[str, GateThreshold] = Field(default_factory=dict)
    cases: list[EvaluationCase] = Field(..., min_length=1, max_length=MAX_CASES_PER_REQUEST)

    # Phase 3: only required when at least one case actually requests semantic evaluation
    # (sets contexts and/or ground_truth) - see llm_judge.py's fail-closed check. Never logged;
    # see main.py's safe-logging discipline.
    llm_api_key: str | None = Field(default=None, max_length=1_000)
    llm_model: str = Field(default="gpt-4o-mini", max_length=MAX_IDENTIFIER_CHARS)
    embedding_model: str = Field(default="text-embedding-3-small", max_length=MAX_IDENTIFIER_CHARS)

    model_config = ConfigDict(extra="forbid")


MetricKind = Literal["deterministic", "llm_judged"]
GateStatus = Literal["pass", "fail", "skipped_no_data"]


class MetricValue(BaseModel):
    value: float | None
    applicable_cases: int
    # Phase 1 correction: every metric is tagged with its kind from day one, even though every
    # Phase 1 metric is "deterministic" - this is the mechanism Phase 3's Ragas/DeepEval
    # LLM-judged metrics plug into without a contract change. Never assume an LLM-judged
    # evaluation is deterministic once metric_kind starts reporting "llm_judged".
    metric_kind: MetricKind = "deterministic"


class GateResult(BaseModel):
    metric: str
    status: GateStatus
    actual: float | None
    threshold: float | None


class CaseResult(BaseModel):
    case_id: str
    recall_at_k: float | None = None
    precision_at_k: float | None = None
    required_fact_rate: float | None = None
    abstained_correctly: bool | None = None
    latency_ms: float | None = None
    # Phase 3: per-case semantic scores, present only for cases applicable to each metric.
    context_precision: float | None = None
    context_recall: float | None = None
    faithfulness: float | None = None
    answer_correctness: float | None = None
    answer_relevancy: float | None = None
    hallucination: float | None = None
    deepeval_correctness: float | None = None


class EvaluatorMetadata(BaseModel):
    """Phase 1 reproducibility correction, populated once semantic metrics are actually used:
    library versions, judge model, and embedding model - never assume an LLM-judged evaluation
    is deterministic or silently reproducible without this recorded."""

    ragas_version: str | None = None
    deepeval_version: str | None = None
    llm_model: str | None = None
    embedding_model: str | None = None


class EvaluationResponse(BaseModel):
    dataset_id: str
    dataset_version: str
    application_id: str
    application_version: str
    evaluator_version: str = EVALUATOR_VERSION
    case_count: int
    metrics: dict[str, MetricValue]
    gate_results: list[GateResult]
    overall_gate_status: GateStatus
    case_results: list[CaseResult]
    evaluator_metadata: EvaluatorMetadata = Field(default_factory=EvaluatorMetadata)
