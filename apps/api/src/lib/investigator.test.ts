import test from "node:test";
import assert from "node:assert/strict";
import { investigateFailure } from "./investigator.js";

// Ticket INV.1 - pure-function unit tests, zero I/O (matches autonomous-planner.test.ts's
// no-DB-needed style). Covers every RepairFailureClass value's mapping individually, confirms
// the two message-only-unreachable branches genuinely never fire, and the frozen precedence
// rule / evidence-availability semantics.

function hasSignal(result: ReturnType<typeof investigateFailure>, source: string, value: string) {
  return result.matchedSignals.some((s) => s.source === source && s.value === value);
}

test("null message: UNKNOWN, evidenceAvailable false, no signals", () => {
  const result = investigateFailure({ message: null });
  assert.deepEqual(result, { verdict: "UNKNOWN", evidenceAvailable: false, matchedSignals: [] });
});

test("whitespace-only message: UNKNOWN, evidenceAvailable false, no signals (not treated as 'classified, matched nothing')", () => {
  const result = investigateFailure({ message: "   \n\t  " });
  assert.deepEqual(result, { verdict: "UNKNOWN", evidenceAvailable: false, matchedSignals: [] });
});

test("a real but unrecognized message: UNKNOWN, evidenceAvailable true, no signals", () => {
  const result = investigateFailure({ message: "Something went wrong in a way nothing here recognizes." });
  assert.equal(result.verdict, "UNKNOWN");
  assert.equal(result.evidenceAvailable, true);
  assert.deepEqual(result.matchedSignals, []);
});

test("navigation_timeout -> AUTOMATION_DRIFT", () => {
  const result = investigateFailure({ message: "page.goto: Timeout 30000ms exceeded." });
  assert.equal(result.verdict, "AUTOMATION_DRIFT");
  assert.ok(hasSignal(result, "repairFailureClass", "navigation_timeout"));
});

test("pathname_mismatch -> AUTOMATION_DRIFT", () => {
  const result = investigateFailure({ message: "Expected pathname to start with /checkout but saw /cart" });
  assert.equal(result.verdict, "AUTOMATION_DRIFT");
  assert.ok(hasSignal(result, "repairFailureClass", "pathname_mismatch"));
});

test("identity_mismatch -> AUTOMATION_DRIFT", () => {
  const result = investigateFailure({ message: "IDENTITY_MISMATCH: expected role admin, got user" });
  assert.equal(result.verdict, "AUTOMATION_DRIFT");
  assert.ok(hasSignal(result, "repairFailureClass", "identity_mismatch"));
});

test("strict_mode_locator -> AUTOMATION_DRIFT", () => {
  const result = investigateFailure({ message: "strict mode violation: locator resolved to 2 elements" });
  assert.equal(result.verdict, "AUTOMATION_DRIFT");
  assert.ok(hasSignal(result, "repairFailureClass", "strict_mode_locator"));
});

test("locator_resolution_failed -> AUTOMATION_DRIFT", () => {
  const result = investigateFailure({ message: "LOCATOR_RESOLUTION_FAILED: could not resolve #submit-button" });
  assert.equal(result.verdict, "AUTOMATION_DRIFT");
  assert.ok(hasSignal(result, "repairFailureClass", "locator_resolution_failed"));
});

test("url_assertion -> AUTOMATION_DRIFT", () => {
  const result = investigateFailure({ message: "expect(page).toHaveURL: failed" });
  assert.equal(result.verdict, "AUTOMATION_DRIFT");
  assert.ok(hasSignal(result, "repairFailureClass", "url_assertion"));
});

test("missing_text_assertion -> AUTOMATION_DRIFT (requires both getByText( and not found/visible/Timeout)", () => {
  const result = investigateFailure({ message: "locator.getByText('Submit') not found: Timeout 5000ms exceeded" });
  assert.equal(result.verdict, "AUTOMATION_DRIFT");
  assert.ok(hasSignal(result, "repairFailureClass", "missing_text_assertion"));
});

test("role_locator_missing -> AUTOMATION_DRIFT (requires both getByRole( and not found/visible/Timeout)", () => {
  const result = investigateFailure({ message: "locator.getByRole('button') not visible: Timeout 5000ms exceeded" });
  assert.equal(result.verdict, "AUTOMATION_DRIFT");
  assert.ok(hasSignal(result, "repairFailureClass", "role_locator_missing"));
});

test("login_selector_timeout -> AUTOMATION_DRIFT, reachable via its message-only branch", () => {
  const result = investigateFailure({ message: "usernameSelector timed out waiting for element to be visible" });
  assert.equal(result.verdict, "AUTOMATION_DRIFT");
  assert.ok(hasSignal(result, "repairFailureClass", "login_selector_timeout"));
});

test("css_selector_parse_error -> AUTOMATION_DRIFT, technically reachable via message alone (regex runs against the concatenated message/stderr/stdout string, which includes message)", () => {
  const result = investigateFailure({ message: "Unexpected token '>' while parsing css selector '#a >> b'" });
  assert.equal(result.verdict, "AUTOMATION_DRIFT");
  assert.ok(hasSignal(result, "repairFailureClass", "css_selector_parse_error"));
});

test("missing_locator_comment is structurally unreachable: its only condition tests specContent, which is never supplied", () => {
  const result = investigateFailure({ message: "// Missing locator for #foo, add it to shared locators and rerun generation." });
  assert.equal(result.verdict, "UNKNOWN", "the specContent-only pattern appearing in message text must not trigger the class");
  assert.ok(!hasSignal(result, "repairFailureClass", "missing_locator_comment"));
});

test("login_selector_timeout's spec/title branch is structurally unreachable: specContent/testTitle are never supplied, only the message branch can fire", () => {
  // A message that is itself unrelated to login, so only the (loginInSpec && loginRelatedTitle)
  // branch could theoretically fire - and it can't, since both specContent and testTitle are
  // always omitted from investigator.ts's call.
  const result = investigateFailure({ message: "some unrelated assertion failure with no login keywords" });
  assert.ok(!hasSignal(result, "repairFailureClass", "login_selector_timeout"));
});

test("isInfraError-first precedence: a message matching both an infra pattern and a RepairFailureClass pattern verdicts ENVIRONMENT_FAILURE, but matchedSignals reports both", () => {
  const result = investigateFailure({
    message: "strict mode violation: locator resolved to 2 elements; net::ERR_CONNECTION_REFUSED",
  });
  assert.equal(result.verdict, "ENVIRONMENT_FAILURE", "infra must win precedence over automation-drift-shaped signals");
  assert.ok(hasSignal(result, "infraError", "infra-error"));
  assert.ok(hasSignal(result, "repairFailureClass", "strict_mode_locator"), "matchedSignals must still show everything that matched, regardless of which one won precedence");
});

test("isInfraError alone (no RepairFailureClass match) -> ENVIRONMENT_FAILURE", () => {
  const result = investigateFailure({ message: "socket hang up" });
  assert.equal(result.verdict, "ENVIRONMENT_FAILURE");
  assert.deepEqual(result.matchedSignals, [{ source: "infraError", value: "infra-error" }]);
});
