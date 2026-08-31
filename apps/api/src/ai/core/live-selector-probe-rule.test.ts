import test from "node:test";
import assert from "node:assert/strict";
import { tryLiveSelectorProbeRepair } from "./live-selector-probe-rule.js";
import type { AiExecutionContext } from "./types.js";
import type { ProbeOutcome } from "../../testmind/runtime/live-page-probe.js";

// Mirrors generator.ts's actual emission format exactly (test.step title = "N. Fill|Click
// <raw selector>", JSON.stringify-escaped; body = formatMissingLocatorAction's
// "// Missing locator <bucket>.<name> on <pagePath>; add it to shared locators and rerun
// generation." comment) rather than a guessed shape — see generator.ts:348-353,539-544.
const FIXTURE_SPEC = `import { test, expect } from '@playwright/test';

test("Forgot password flow", async ({ page }, testInfo) => {
  await test.step("1. Navigate to /forgot-password", async () => {
    try {
      await page.goto(\`\${BASE_URL}/forgot-password\`);
      await ensurePageIdentity(page, "/forgot-password");
    } finally {
      await captureStepArtifact(page, testInfo, "1. Navigate to /forgot-password");
    }
  });
  await test.step("2. Fill [name=\\"forgot-email-input\\"]", async () => {
    try {
// Missing locator fields.forgot-email-input on /forgot-password; add it to shared locators and rerun generation.
    } finally {
      await captureStepArtifact(page, testInfo, "2. Fill [name=\\"forgot-email-input\\"]");
    }
  });
  await test.step("3. Click button[type=\\"submit\\"]", async () => {
    try {
// Missing locator buttons.button-type-submit on /forgot-password; add it to shared locators and rerun generation.
    } finally {
      await captureStepArtifact(page, testInfo, "3. Click button[type=\\"submit\\"]");
    }
  });
});

test("A different test", async ({ page }, testInfo) => {
  await test.step("1. Navigate to /login", async () => {
    try {
      await page.goto(\`\${BASE_URL}/login\`);
    } finally {
      await captureStepArtifact(page, testInfo, "1. Navigate to /login");
    }
  });
});
`;

function baseContext(overrides?: Partial<AiExecutionContext>): AiExecutionContext {
  return {
    mode: "repair",
    job: {
      runId: "run_1",
      testResultId: "result_1",
      testCaseId: "case_1",
      attemptId: "attempt_1",
      projectId: "project_1",
      totalFailed: 1,
      testTitle: "Forgot password flow",
      baseUrl: "https://www.bes-app.com",
    },
    scope: { projectId: "project_1", testCaseId: "case_1" },
    repoRoot: "/repo",
    repoRelativePath: "spec.ts",
    repoAbsolutePath: "/repo/spec.ts",
    specContent: FIXTURE_SPEC,
    failure: { testTitle: "Forgot password flow" },
    evidence: { failureClasses: ["missing_locator_comment"], artifacts: [] },
    ...overrides,
  } as AiExecutionContext;
}

function okOutcome(entries: Array<{ key: string; selector: string | null; matchCount: number | null }>): ProbeOutcome {
  return {
    ok: true,
    authGated: false,
    finalUrl: "https://www.bes-app.com/forgot-password",
    results: entries.map((e) => ({
      key: e.key,
      selectedSelector: e.selector,
      matchCount: e.matchCount,
      attemptedSelectors: e.selector ? [e.selector] : [],
    })),
  };
}

test("tryLiveSelectorProbeRepair patches both fill and click sites when both resolve uniquely", async () => {
  let callCount = 0;
  const result = await tryLiveSelectorProbeRepair(
    baseContext(),
    {},
    {
      probe: async (_url, targets) => {
        callCount++;
        assert.equal(targets.length, 2);
        return okOutcome([
          { key: "fields.forgot-email-input", selector: '[name="forgot-email-input"]', matchCount: 1 },
          { key: "buttons.button-type-submit", selector: 'button[type="submit"]', matchCount: 1 },
        ]);
      },
    }
  );

  assert.equal(callCount, 1);
  assert.ok(result);
  assert.equal(result?.kind, "rule");
  assert.equal(result?.fixType, "rule_fixed");
  assert.ok(result?.patchedSpec.includes(
    `await page.locator("[name=\\"forgot-email-input\\"]").first().fill("qa+auto@example.com");`
  ));
  assert.ok(result?.patchedSpec.includes(`await page.locator("button[type=\\"submit\\"]").first().click();`));
  assert.ok(!result?.patchedSpec.includes("// Missing locator fields.forgot-email-input"));
  assert.ok(!result?.patchedSpec.includes("// Missing locator buttons.button-type-submit"));
  // the unrelated second test in the file must be untouched
  assert.ok(result?.patchedSpec.includes('await test.step("1. Navigate to /login"'));

  const fixDetails = result?.fixDetails as any;
  assert.equal(fixDetails.tier, "live-probe");
  assert.equal(fixDetails.healingAttemptId, "attempt_1");
  assert.equal(fixDetails.testCaseId, "case_1");
  assert.equal(fixDetails.resolved.length, 2);
  assert.equal(fixDetails.pendingLocatorPromotion.length, 2);
  assert.equal(fixDetails.pendingLocatorPromotion[0].projectId, "project_1");
  assert.equal(fixDetails.pendingLocatorPromotion[0].pagePath, "/forgot-password");
});

test("tryLiveSelectorProbeRepair applies a partial patch when only one site resolves", async () => {
  const result = await tryLiveSelectorProbeRepair(
    baseContext(),
    {},
    {
      probe: async () =>
        okOutcome([
          { key: "fields.forgot-email-input", selector: '[name="forgot-email-input"]', matchCount: 1 },
          { key: "buttons.button-type-submit", selector: null, matchCount: null },
        ]),
    }
  );

  assert.ok(result);
  assert.ok(result?.patchedSpec.includes(".first().fill("));
  // the unresolved site keeps its original placeholder untouched
  assert.ok(result?.patchedSpec.includes("// Missing locator buttons.button-type-submit"));
  const fixDetails = result?.fixDetails as any;
  assert.equal(fixDetails.resolved.length, 1);
  assert.equal(fixDetails.pendingLocatorPromotion.length, 1);
});

test("tryLiveSelectorProbeRepair excludes non-unique (matchCount > 1) selectors from promotion but still applies the repair", async () => {
  const result = await tryLiveSelectorProbeRepair(
    baseContext(),
    {},
    {
      probe: async () =>
        okOutcome([
          { key: "fields.forgot-email-input", selector: '[name="forgot-email-input"]', matchCount: 1 },
          { key: "buttons.button-type-submit", selector: "button", matchCount: 6 },
        ]),
    }
  );

  assert.ok(result);
  // still patched into the spec for the one-off repair
  assert.ok(result?.patchedSpec.includes(`await page.locator("button").first().click();`));
  const fixDetails = result?.fixDetails as any;
  assert.equal(fixDetails.resolved.length, 2);
  // but only the unique one is eligible for shared-locator promotion
  assert.equal(fixDetails.pendingLocatorPromotion.length, 1);
  assert.equal(fixDetails.pendingLocatorPromotion[0].name, "forgot-email-input");
});

test("tryLiveSelectorProbeRepair orders the generic fallback candidates (input, button) by step kind", async () => {
  // Regression test for a real finding from manual validation against a live site: the
  // shared generateSelectorSuggestions always appends "input" before "button", so a click
  // target whose specific candidates all fail to resolve could land on the page's one
  // <input> before ever trying <button>. Confirmed live against bes-app.com's
  // forgot-password page (a submit <button> with no type="submit" attribute, one bare
  // <input> on the page) before this fix existed.
  let capturedTargets: any[] = [];
  await tryLiveSelectorProbeRepair(
    baseContext(),
    {},
    {
      probe: async (_url, targets) => {
        capturedTargets = targets;
        return okOutcome([
          { key: "fields.forgot-email-input", selector: null, matchCount: null },
          { key: "buttons.button-type-submit", selector: null, matchCount: null },
        ]);
      },
    }
  );

  const fillTarget = capturedTargets.find((t) => t.key === "fields.forgot-email-input");
  const clickTarget = capturedTargets.find((t) => t.key === "buttons.button-type-submit");

  // Both "input" and "button" are present in each list (generateSelectorSuggestions always
  // pushes both as a last resort) - what matters is their relative order per kind.
  assert.ok(fillTarget.candidates.includes("input"));
  assert.ok(fillTarget.candidates.includes("button"));
  assert.ok(
    fillTarget.candidates.indexOf("input") < fillTarget.candidates.indexOf("button"),
    "fill target should try input before button"
  );

  assert.ok(clickTarget.candidates.includes("input"));
  assert.ok(clickTarget.candidates.includes("button"));
  assert.ok(
    clickTarget.candidates.indexOf("button") < clickTarget.candidates.indexOf("input"),
    "click target should try button before input"
  );
});

test("tryLiveSelectorProbeRepair returns null and never calls the probe when the page path looks auth-gated", async () => {
  const spec = FIXTURE_SPEC.replace(/\/forgot-password/g, "/login");
  let called = false;
  const result = await tryLiveSelectorProbeRepair(
    baseContext({ specContent: spec }),
    {},
    { probe: async () => { called = true; return okOutcome([]); } }
  );
  assert.equal(result, null);
  assert.equal(called, false);
});

test("tryLiveSelectorProbeRepair returns null when the job has no baseUrl", async () => {
  const ctx = baseContext();
  (ctx.job as any).baseUrl = undefined;
  const result = await tryLiveSelectorProbeRepair(ctx, {}, { probe: async () => okOutcome([]) });
  assert.equal(result, null);
});

test("tryLiveSelectorProbeRepair returns null when missing_locator_comment isn't in the failure classes", async () => {
  const ctx = baseContext({ evidence: { failureClasses: ["some_other_class"], artifacts: [] } });
  const result = await tryLiveSelectorProbeRepair(ctx, {}, { probe: async () => okOutcome([]) });
  assert.equal(result, null);
});

test("tryLiveSelectorProbeRepair returns null when the probe outcome is ok:false", async () => {
  const result = await tryLiveSelectorProbeRepair(
    baseContext(),
    {},
    { probe: async () => ({ ok: false, authGated: false, reason: "Navigation failed: timeout" }) }
  );
  assert.equal(result, null);
});

test("tryLiveSelectorProbeRepair degrades to null (never hangs) when the probe never resolves", async () => {
  const result = await tryLiveSelectorProbeRepair(
    baseContext(),
    { totalBudgetMs: 200 },
    { probe: () => new Promise(() => {}) }
  );
  assert.equal(result, null);
});
