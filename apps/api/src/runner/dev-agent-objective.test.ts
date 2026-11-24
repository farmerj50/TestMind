import test from "node:test";
import assert from "node:assert/strict";
import { checkObjectiveAlignment, extractAssertionTargets, hasSkipMarker } from "./dev-agent-objective.js";
import { parseBlockedSignal } from "./dev-agent-worker.js";

// The real Bes run (cmwtj7u7c00037kc4vsimm11r): instruction, iteration 1 (failed - the
// element is not on the live page), iteration 2 (passed by asserting a DIFFERENT button
// while keeping the original test title).
const BES_INSTRUCTION = "Generate exactly one Playwright test at tests/dev-agent-verification/bes-landing.spec.ts that navigates to the real Bes landing page and asserts the Get Started button is visible. Do not create or modify any other files.";
const BES_ITER1 = `import { test, expect } from '@playwright/test';

test('Get Started button is visible on Bes landing page', async ({ page }) => {
 await page.goto('https://www.bes-app.com');
 const getStartedButton = page.locator('button:has-text("Get Started")');
 await expect(getStartedButton).toBeVisible();
});`;
const BES_ITER2 = `import { test, expect } from '@playwright/test';

test('Get Started button is visible on Bes landing page', async ({ page }) => {
 await page.goto('https://www.bes-app.com');
 const getStartedButton = page.locator('button:has-text("Continue with Email")');
 await expect(getStartedButton).toBeVisible();
});`;
const SPEC = "tests/dev-agent-verification/bes-landing.spec.ts";

test("extractAssertionTargets reads what expect() checks - through variables - not the test title", () => {
  assert.deepEqual(extractAssertionTargets(BES_ITER1), [{ text: "Get Started", negated: false }]);
  assert.deepEqual(extractAssertionTargets(BES_ITER2), [{ text: "Continue with Email", negated: false }]);
});

test("REGRESSION: a failed 'Get Started' test repaired into a passing 'Continue with Email' test is NOT aligned", () => {
  const original = extractAssertionTargets(BES_ITER1);
  const result = checkObjectiveAlignment({ instructionText: BES_INSTRUCTION, originalTargets: original, finalTestFiles: [{ path: SPEC, content: BES_ITER2 }] });
  assert.equal(result.aligned, false);
  assert.match(result.reason, /changed the test objective/);
  assert.match(result.reason, /Get Started/);
  assert.match(result.reason, /Continue with Email/);
});

test("REGRESSION: substituting on the FIRST attempt (no earlier baseline) is still caught against the instruction", () => {
  const result = checkObjectiveAlignment({ instructionText: BES_INSTRUCTION, originalTargets: null, finalTestFiles: [{ path: SPEC, content: BES_ITER2 }] });
  assert.equal(result.aligned, false);
  assert.match(result.reason, /No assertion in the final test checks anything named in the instruction/);
});

test("legitimate repairs (selector strategy, waits, navigation, extra assertions) stay aligned", () => {
  const repaired = `import { test, expect } from '@playwright/test';
test('Get Started button is visible', async ({ page }) => {
  await page.goto('https://www.bes-app.com', { waitUntil: 'networkidle' });
  // old: page.locator('button:has-text("Get Started")')
  const cta = page.getByRole('button', { name: /get started/i });
  await cta.waitFor({ state: 'visible', timeout: 15000 });
  await expect(cta).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Welcome to Bes' })).toBeVisible();
});`;
  const result = checkObjectiveAlignment({ instructionText: BES_INSTRUCTION, originalTargets: extractAssertionTargets(BES_ITER1), finalTestFiles: [{ path: SPEC, content: repaired }] });
  assert.equal(result.aligned, true, result.reason);
  assert.match(result.reason, /get started/i);
});

test("keeping the original target only in a comment or the test title does not count", () => {
  const sneaky = `test('Get Started button is visible', async ({ page }) => {
  // await expect(page.getByText('Get Started')).toBeVisible();
  /* expect(page.getByText("Get Started")).toBeVisible() */
  await expect(page.getByText('Continue with Email')).toBeVisible();
});`;
  const result = checkObjectiveAlignment({ instructionText: BES_INSTRUCTION, originalTargets: extractAssertionTargets(BES_ITER1), finalTestFiles: [{ path: SPEC, content: sneaky }] });
  assert.equal(result.aligned, false);
});

test("inverting the objective (asserting the requested element is absent) is not aligned", () => {
  for (const body of [
    "await expect(page.getByText('Get Started')).not.toBeVisible();",
    "await expect(page.getByText('Get Started')).toBeHidden();",
    "await expect(page.locator('button:has-text(\"Get Started\")')).toHaveCount(0);",
  ]) {
    const src = `test('x', async ({ page }) => { ${body} await expect(page.getByText('Continue with Email')).toBeVisible(); });`;
    const result = checkObjectiveAlignment({ instructionText: BES_INSTRUCTION, originalTargets: extractAssertionTargets(BES_ITER1), finalTestFiles: [{ path: SPEC, content: src }] });
    assert.equal(result.aligned, false, body);
  }
  // ...unless the instruction itself asks for absence.
  const absent = "test('x', async ({ page }) => { await expect(page.getByText('Get Started')).toBeHidden(); });";
  const ok = checkObjectiveAlignment({ instructionText: "assert the Get Started button is no longer shown after login", originalTargets: null, finalTestFiles: [{ path: SPEC, content: absent }] });
  assert.equal(ok.aligned, true, ok.reason);
});

test("skipped / fixme / expected-fail tests and deleted test files are never aligned", () => {
  for (const marker of ["test.skip(", "test.fixme(", "test.fail(", "test.describe.skip("]) {
    const src = `${marker}'Get Started', async ({ page }) => { await expect(page.getByText('Get Started')).toBeVisible(); });`;
    assert.equal(hasSkipMarker(src), true, marker);
    const result = checkObjectiveAlignment({ instructionText: BES_INSTRUCTION, originalTargets: null, finalTestFiles: [{ path: SPEC, content: src }] });
    assert.equal(result.aligned, false, marker);
  }
  const deleted = checkObjectiveAlignment({ instructionText: BES_INSTRUCTION, originalTargets: null, finalTestFiles: [{ path: SPEC, content: null }] });
  assert.equal(deleted.aligned, false);
  assert.match(deleted.reason, /deleted/);
});

test("no test files touched by the agent: the configured test command remains the verification", () => {
  const result = checkObjectiveAlignment({ instructionText: "fix the null check in the parser", originalTargets: null, finalTestFiles: [] });
  assert.equal(result.aligned, true);
});

test("parseBlockedSignal recognizes the model's 'requested element does not exist' response and nothing else", () => {
  assert.equal(parseBlockedSignal('{"blocked": true, "reason": "No Get Started button on the landing page"}'), "No Get Started button on the landing page");
  assert.equal(parseBlockedSignal('```json\n{"blocked": true, "reason": "missing"}\n```'), "missing");
  assert.equal(parseBlockedSignal('[{"path":"a.spec.ts","action":"create","content":"x"}]'), null);
  assert.equal(parseBlockedSignal('{"blocked": false}'), null);
  assert.equal(parseBlockedSignal("not json"), null);
});

test("hasText filters count as asserted text (a common, legitimate selector repair)", () => {
  assert.deepEqual(
    extractAssertionTargets(`await expect(page.locator('[data-testid="cta"]').filter({ hasText: 'Get Started' })).toBeVisible();`),
    [{ text: "Get Started", negated: false }],
  );
});
