import test from "node:test";
import assert from "node:assert/strict";
import {
  deriveDecisionForFailureClassification,
  deriveDecisionsForFailureClassifications,
  type FailureClassification,
} from "./operator-decisions.js";

function classification(overrides: Partial<FailureClassification>): FailureClassification {
  return {
    type: "self-heal",
    testResultId: "result_1",
    testCaseId: "case_1",
    title: "Some test",
    message: null,
    ...overrides,
  };
}

test("self-heal classification maps to a heal decision", () => {
  const d = deriveDecisionForFailureClassification(
    classification({ type: "self-heal", message: "Error: locator resolution failed, element(s) not found" })
  );
  assert.equal(d.decisionType, "heal");
});

test("blocked classification maps to an escalate decision", () => {
  const d = deriveDecisionForFailureClassification(classification({ type: "blocked", message: "Error: net::ERR_CONNECTION_REFUSED" }));
  assert.equal(d.decisionType, "escalate");
});

test("defect classification maps to an escalate decision", () => {
  const d = deriveDecisionForFailureClassification(classification({ type: "defect", message: "Expected 200, got 500" }));
  assert.equal(d.decisionType, "escalate");
});

test("rationale names the specific matched signal(s)", () => {
  const d = deriveDecisionForFailureClassification(
    classification({ type: "self-heal", message: "TimeoutError waiting for selector to be visible (strict mode violation)" })
  );
  assert.match(d.rationale, /waiting for/);
  assert.match(d.rationale, /selector/);
  assert.match(d.rationale, /strict mode violation/);
});

test("confidence is bounded to [0,1] and monotonic in matched-signal count", () => {
  const zero = deriveDecisionForFailureClassification(classification({ type: "defect", message: "totally unrelated failure text" }));
  const one = deriveDecisionForFailureClassification(classification({ type: "self-heal", message: "locator error" }));
  const many = deriveDecisionForFailureClassification(
    classification({ type: "self-heal", message: "locator tobevisible element(s) not found waiting for selector strict mode violation" })
  );
  for (const d of [zero, one, many]) {
    assert.ok(d.confidence >= 0 && d.confidence <= 1);
  }
  assert.ok(one.confidence > zero.confidence);
  assert.ok(many.confidence > one.confidence);
});

test("evidenceJson round-trips testResultId/testCaseId/message", () => {
  const d = deriveDecisionForFailureClassification(
    classification({ testResultId: "r1", testCaseId: "c1", message: "locator not found", title: "My test" })
  );
  assert.equal(d.evidenceJson.testResultId, "r1");
  assert.equal(d.evidenceJson.testCaseId, "c1");
  assert.equal(d.evidenceJson.message, "locator not found");
  assert.equal(d.evidenceJson.title, "My test");
});

test("deriveDecisionsForFailureClassifications maps a list 1:1, preserving order", () => {
  const list = [
    classification({ type: "self-heal", testResultId: "r1" }),
    classification({ type: "blocked", testResultId: "r2" }),
    classification({ type: "defect", testResultId: "r3" }),
  ];
  const decisions = deriveDecisionsForFailureClassifications(list);
  assert.equal(decisions.length, 3);
  assert.deepEqual(
    decisions.map((d) => d.decisionType),
    ["heal", "escalate", "escalate"]
  );
});

test("model is a descriptive rule-based tag, not an LLM model id", () => {
  const d = deriveDecisionForFailureClassification(classification({}));
  assert.equal(d.model, "rule:classifyRunFailures/keyword-heuristic");
});
