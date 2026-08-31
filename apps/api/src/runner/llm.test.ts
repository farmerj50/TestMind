import test from "node:test";
import assert from "node:assert/strict";
import { normalizeOpTypes } from "./llm.js";

test("normalizeOpTypes unwraps operations the model keyed by their own type name", () => {
  // Captured verbatim from a real self-heal failure (2026-08-25) that had recurred
  // repeatedly since at least 2026-08-09 without ever being diagnosable — the model
  // returned {"replace_literal": {"type": "text", "find": ..., "replace": ...}} instead
  // of the expected flat {"type": "replace_literal", "find": ..., "replace": ...}, so
  // every field-based heuristic silently failed (op.find/op.replace didn't exist at the
  // top level) and the discriminated union rejected every operation.
  const raw = JSON.stringify({
    summary: "Updated the test to fix the locator for the success message after form submission.",
    operations: [
      {
        replace_literal: {
          type: "text",
          find: "// Missing locator fields.name-forgot-email-input-forgot-email-input on /forgot-password; add it to shared locators and rerun generation.",
          replace: "await page.fill('[name=\"forgot-email-input\"]', 'test@example.com');",
        },
      },
      {
        replace_literal: {
          type: "text",
          find: "// Missing locator locators.button-type-submit-input-type-submit on /forgot-password; add it to shared locators and rerun generation.",
          replace: "await page.click('button[type=\"submit\"]');",
        },
      },
      {
        replace_regex_once: {
          type: "text",
          pattern: "await expect\\(page\\.getByText\\(rawText\\)\\)\\.toBeVisible\\(\\{ timeout: 10000 \\}\\);",
          replace:
            "await expect(page.getByText(/success|thank(?:s| you)|confirm(?:ed|ation)?|complete[d]?|submitted|received|sent|done|check your (?:email|inbox)/i)).toBeVisible({ timeout: 10000 });",
        },
      },
    ],
  });

  const normalized = JSON.parse(normalizeOpTypes(raw));

  assert.equal(normalized.operations.length, 3);
  assert.equal(normalized.operations[0].type, "replace_literal");
  assert.ok(normalized.operations[0].find.startsWith("// Missing locator fields.name"));
  assert.ok(normalized.operations[0].replace.includes("page.fill"));
  assert.equal(normalized.operations[1].type, "replace_literal");
  assert.ok(normalized.operations[1].replace.includes("page.click"));
  assert.equal(normalized.operations[2].type, "replace_regex_once");
  assert.ok(normalized.operations[2].pattern.includes("getByText"));
});

test("normalizeOpTypes leaves already-flat operations untouched", () => {
  const raw = JSON.stringify({
    summary: "fix",
    operations: [{ type: "replace_literal", find: "a", replace: "b" }],
  });
  const normalized = JSON.parse(normalizeOpTypes(raw));
  assert.deepEqual(normalized.operations[0], { type: "replace_literal", find: "a", replace: "b" });
});

test("normalizeOpTypes still applies known type aliases (unrelated to the wrapper bug)", () => {
  const raw = JSON.stringify({
    summary: "fix",
    operations: [{ type: "replace", find: "a", replace: "b" }],
  });
  const normalized = JSON.parse(normalizeOpTypes(raw));
  assert.equal(normalized.operations[0].type, "replace_literal");
});
