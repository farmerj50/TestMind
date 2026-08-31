import test from "node:test";
import assert from "node:assert/strict";
import { classifyFailureContext, validatePatchedSpec } from "./repair-policy.js";

const DEFAULT_LIMITS = { maxChangedLines: 220, maxBytesDelta: 28000 };

test("validatePatchedSpec rejects a patch that leaves the exact failing locator unchanged", () => {
  // Regression test for a real, captured self-heal failure: the LLM reported "succeeded"
  // and changed a test.step's cosmetic display title away from the stale text, but left the
  // actual `rawText` variable the assertion runs against completely untouched - so the
  // patched test was guaranteed to fail identically on rerun (and did, confirmed live).
  // validatePatchedSpec previously had no way to catch this: byte-delta and line-count
  // limits don't care WHAT changed, only how much.
  const before = `
  await test.step("2. Ensure text \\"JusticePath — Accessible Legal Help\\" is visible", async () => {
    try {
    {
      const rawText = "JusticePath — Accessible Legal Help";
      await expect(page.getByText(rawText)).toBeVisible({ timeout: 10000 });
    }
    } finally {}
  });`;
  // The real diff this bug produced: title changed, rawText (the actual assertion target)
  // did not.
  const after = `
  await test.step("2. Ensure text \\"⚖️ JusticePath\\" is visible", async () => {
    try {
    {
      const rawText = "JusticePath — Accessible Legal Help";
      await expect(page.getByText(rawText)).toBeVisible({ timeout: 10000 });
    }
    } finally {}
  });`;
  const failureMessage =
    "Error: expect(locator).toBeVisible() failed\n\n" +
    "Locator: getByText('JusticePath — Accessible Legal Help')\n" +
    "Expected: visible\nTimeout: 10000ms\nError: element(s) not found";

  const result = validatePatchedSpec(before, after, "playwright-ts", DEFAULT_LIMITS, failureMessage);
  assert.ok(result, "expected the patch to be rejected");
  assert.match(result!, /still references the exact failing locator text, unchanged/);
});

test("validatePatchedSpec accepts a patch that actually changes the failing locator", () => {
  const before = `await expect(page.getByText('JusticePath — Accessible Legal Help')).toBeVisible({ timeout: 10000 });`;
  const after = `await expect(page.getByText('⚖️ JusticePath')).toBeVisible({ timeout: 10000 });`;
  const failureMessage = "Locator: getByText('JusticePath — Accessible Legal Help')\nError: element(s) not found";

  const result = validatePatchedSpec(before, after, "playwright-ts", DEFAULT_LIMITS, failureMessage);
  assert.equal(result, null);
});

test("validatePatchedSpec is a no-op for this check when the failure message has no Locator: line", () => {
  const before = `await page.goto('/checkout');`;
  const after = `await page.goto('/checkout', { timeout: 30000 });`;
  const failureMessage = "Test timeout of 30000ms exceeded.";

  const result = validatePatchedSpec(before, after, "playwright-ts", DEFAULT_LIMITS, failureMessage);
  assert.equal(result, null);
});

test("validatePatchedSpec still works when failureMessage is omitted entirely (backward compatible)", () => {
  const before = `await page.goto('/checkout');`;
  const after = `await page.goto('/checkout', { timeout: 30000 });`;
  const result = validatePatchedSpec(before, after, "playwright-ts", DEFAULT_LIMITS);
  assert.equal(result, null);
});

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
