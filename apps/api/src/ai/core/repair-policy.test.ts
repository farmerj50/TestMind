import test from "node:test";
import assert from "node:assert/strict";
import { classifyFailureContext } from "./repair-policy.js";

test("classifyFailureContext does not misclassify a forgot-password page as a login-selector timeout", () => {
  // Regression test for a real finding: /login|sign.?in|auth|password|email/i matched the
  // bare substring "password" in "Form submits – /forgot-password", routing the failure
  // into tryLoginSelectorRepair (a fix for the shared login helper, unrelated to this page)
  // instead of letting missing_locator_comment-driven repair (Tier 1/2/3) handle the real
  // problem. Confirmed live against a real self-heal run before this fix.
  const classes = classifyFailureContext({
    message: "Expect \"toBeVisible\" with timeout 10000ms waiting for getByText(/success/i)",
    specContent: "async function sharedLogin(page: Page) { /* ... */ }",
    testTitle: "Form submits – /forgot-password",
  });
  assert.ok(!classes.includes("login_selector_timeout"));
});

test("classifyFailureContext still classifies a genuine login test title as login_selector_timeout", () => {
  const classes = classifyFailureContext({
    message: "some timeout",
    specContent: "async function sharedLogin(page: Page) { /* ... */ }",
    testTitle: "Login page loads",
  });
  assert.ok(classes.includes("login_selector_timeout"));
});

test("classifyFailureContext still classifies sign-in/signin title variants", () => {
  for (const title of ["Sign in flow", "Sign-in flow", "Signin flow"]) {
    const classes = classifyFailureContext({
      message: "some timeout",
      specContent: "async function sharedLogin(page: Page) { /* ... */ }",
      testTitle: title,
    });
    assert.ok(classes.includes("login_selector_timeout"), `expected "${title}" to classify as login_selector_timeout`);
  }
});

test("classifyFailureContext still classifies via the failure message alone, regardless of title", () => {
  const classes = classifyFailureContext({
    message: "Error: usernameSelector not found",
    specContent: "",
    testTitle: "Unrelated page title",
  });
  assert.ok(classes.includes("login_selector_timeout"));
});

test("classifyFailureContext does not misclassify other password/email-named pages", () => {
  for (const title of ["Reset password", "Change email address", "Update payment email"]) {
    const classes = classifyFailureContext({
      message: "some timeout",
      specContent: "async function sharedLogin(page: Page) { /* ... */ }",
      testTitle: title,
    });
    assert.ok(!classes.includes("login_selector_timeout"), `expected "${title}" NOT to classify as login_selector_timeout`);
  }
});

test("classifyFailureContext still detects missing_locator_comment independent of the login fix", () => {
  const classes = classifyFailureContext({
    message: "some failure",
    specContent: "// Missing locator fields.x on /forgot-password; add it to shared locators and rerun generation.",
    testTitle: "Form submits – /forgot-password",
  });
  assert.ok(classes.includes("missing_locator_comment"));
  assert.ok(!classes.includes("login_selector_timeout"));
});
