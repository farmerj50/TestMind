import test from "node:test";
import assert from "node:assert/strict";
import { tryRuleBasedRepair } from "./repair-executor.js";
import type { AiExecutionContext } from "./types.js";

// Regression fixture for a real, captured self-heal failure: the strict-mode-first/
// strict-mode-href rules searched the WHOLE spec file instead of the failing test's own
// block, so they matched an unrelated line inside the shared `snapshotSignals` helper
// (present in every generated spec, defined before any test() block) instead of the
// actual failing locator - producing a no-op patch (a redundant `.first().first()`) that
// was guaranteed to fail identically on rerun, which it did, live, twice.
function buildSpec(failingBlock: string) {
  return [
    'import { test, expect, type Page } from "@playwright/test";',
    "",
    "async function snapshotSignals(page: Page, signals: any) {",
    "  try {",
    "    signals.url = page.url();",
    "    signals.dom.h1 = await page.locator('h1').first().innerText().catch(() => undefined);",
    "    signals.dom.bodyText = (await page.locator('body').innerText().catch(() => '')).slice(0, 2000);",
    "  } catch {}",
    "}",
    "",
    'test("Unrelated passing test", async ({ page }) => {',
    "  await expect(page.getByText('Welcome')).toBeVisible();",
    "});",
    "",
    failingBlock,
  ].join("\n");
}

function baseContext(overrides: Partial<AiExecutionContext>): AiExecutionContext {
  return {
    mode: "repair",
    job: {} as AiExecutionContext["job"],
    scope: { projectId: "p1" },
    repoRoot: "/repo",
    repoRelativePath: "spec.ts",
    repoAbsolutePath: "/repo/spec.ts",
    evidence: { artifacts: [], failureClasses: [] },
    failure: {},
    ...overrides,
  };
}

test("strict-mode-first rule patches the failing test's own locator, not the unrelated snapshotSignals helper", () => {
  const failingBlock = [
    'test("Nav links resolve", async ({ page }) => {',
    "  await expect(page.getByRole('link', { name: 'Home' })).toBeVisible();",
    "});",
  ].join("\n");
  const specContent = buildSpec(failingBlock);

  const context = baseContext({
    specContent,
    failure: {
      testTitle: "Nav links resolve",
      message: 'Error: strict mode violation: getByRole(\'link\', { name: \'Home\' }) resolved to 2 elements',
    },
  });

  const result = tryRuleBasedRepair(context);
  assert.ok(result, "expected the rule to produce a patch");
  assert.equal(result!.fixDetails?.rule, "strict-mode-first");
  // The real failing locator must be the one patched.
  assert.match(
    result!.patchedSpec,
    /getByRole\('link', \{ name: 'Home' \}\)\.first\(\)/,
  );
  // snapshotSignals must be untouched - no redundant double .first().
  assert.match(result!.patchedSpec, /page\.locator\('h1'\)\.first\(\)\.innerText\(\)/);
  assert.doesNotMatch(result!.patchedSpec, /\.first\(\)\.first\(\)/);
});

test("strict-mode-href rule patches the failing test's own locator, not the unrelated snapshotSignals helper", () => {
  const failingBlock = [
    'test("Nav links resolve", async ({ page }) => {',
    "  await expect(page.getByRole('link', { name: 'Home' })).toBeVisible();",
    "});",
  ].join("\n");
  const specContent = buildSpec(failingBlock);

  const context = baseContext({
    specContent,
    failure: {
      testTitle: "Nav links resolve",
      message:
        'Error: strict mode violation: getByRole(\'link\') resolved to 2 elements:\n  - <a href="/about">…</a>',
    },
  });

  const result = tryRuleBasedRepair(context);
  assert.ok(result, "expected the rule to produce a patch");
  assert.equal(result!.fixDetails?.rule, "strict-mode-href");
  assert.match(result!.patchedSpec, /page\.locator\('a\[href="\/about"\]'\)\.first\(\)/);
  assert.match(result!.patchedSpec, /page\.locator\('h1'\)\.first\(\)\.innerText\(\)/);
});

test("strict-mode rules return null (fall through to Tier 2/3) when the failing test's own block has no matching locator", () => {
  const failingBlock = [
    'test("Nav links resolve", async ({ page }) => {',
    "  await expect(page.getByRole('link', { name: 'Home' })).toBeVisible();",
    "});",
  ].join("\n");
  const specContent = buildSpec(failingBlock);

  const context = baseContext({
    specContent,
    failure: {
      // No matching test title in the spec at all.
      testTitle: "Some test that does not exist in this spec",
      message: "Error: strict mode violation: getByRole('link') resolved to 2 elements",
    },
  });

  const result = tryRuleBasedRepair(context);
  assert.equal(result, null);
});
