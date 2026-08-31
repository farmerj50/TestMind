import test from "node:test";
import assert from "node:assert/strict";
import { computeLocatorPromotion, normalizeLocatorPath, selectPromotableEntries } from "./locator-promotion.js";

test("normalizeLocatorPath strips query/hash-insensitive host, keeps pathname+search", () => {
  assert.equal(normalizeLocatorPath("/forgot-password"), "/forgot-password");
  assert.equal(normalizeLocatorPath("forgot-password"), "/forgot-password");
  assert.equal(normalizeLocatorPath("/search?q=1"), "/search?q=1");
  assert.equal(normalizeLocatorPath(""), "/");
});

test("computeLocatorPromotion writes both pages and locatorFallbacks for a brand-new project", () => {
  const next = computeLocatorPromotion(
    {},
    {
      pagePath: "/forgot-password",
      bucket: "fields",
      name: "forgot-email-input",
      primary: "[name=\"forgot-email-input\"]",
      fallbacks: ["#forgot-email-input", "[name=\"forgot-email-input\"]"],
      metadata: { source: "live-selector-probe" },
      userId: "user_1",
    }
  );

  assert.equal(next.pages["/forgot-password"].fields["forgot-email-input"], '[name="forgot-email-input"]');

  const fb = next.locatorFallbacks["/forgot-password"].fields["forgot-email-input"];
  assert.equal(fb.primary, '[name="forgot-email-input"]');
  // the primary must never also appear in its own fallback list, and duplicates must be deduped
  assert.deepEqual(fb.fallbacks, ["#forgot-email-input"]);
  assert.equal(fb.metadata.source, "live-selector-probe");
  assert.equal(typeof fb.metadata.confidenceScore, "number");
  assert.ok(Array.isArray(fb.metadata.confidenceBreakdown));
  assert.equal(fb.updatedBy, "user_1");
  assert.ok(!Number.isNaN(Date.parse(fb.updatedAt)));

  assert.equal(next.locatorMeta.updatedBy, "user_1");
  assert.ok(!Number.isNaN(Date.parse(next.locatorMeta.updatedAt)));
});

test("computeLocatorPromotion merges into existing pages/locatorFallbacks without clobbering unrelated entries", () => {
  const existing = {
    baseUrl: "https://www.bes-app.com",
    pages: {
      "/forgot-password": { fields: { other: "#other" } },
      "/login": { fields: { email: "#email" } },
    },
    locatorFallbacks: {
      "/forgot-password": { fields: { other: { primary: "#other", fallbacks: [], metadata: {} } } },
    },
  };

  const next = computeLocatorPromotion(existing, {
    pagePath: "/forgot-password",
    bucket: "fields",
    name: "forgot-email-input",
    primary: "[name=\"forgot-email-input\"]",
    userId: "user_1",
  });

  // unrelated page untouched
  assert.deepEqual(next.pages["/login"], { fields: { email: "#email" } });
  // unrelated bucket entry on the same page untouched
  assert.equal(next.pages["/forgot-password"].fields.other, "#other");
  // new entry added alongside it
  assert.equal(next.pages["/forgot-password"].fields["forgot-email-input"], '[name="forgot-email-input"]');
  assert.equal(next.locatorFallbacks["/forgot-password"].fields.other.primary, "#other");
  // baseUrl and other top-level sharedSteps keys survive untouched
  assert.equal(next.baseUrl, "https://www.bes-app.com");
});

test("computeLocatorPromotion migrates legacy sharedSteps.locators shape into pages", () => {
  const existing = {
    locators: {
      "/forgot-password": { email: "#old-email" },
    },
  };

  const next = computeLocatorPromotion(existing, {
    pagePath: "/forgot-password",
    bucket: "fields",
    name: "forgot-email-input",
    primary: "[name=\"forgot-email-input\"]",
    userId: "user_1",
  });

  assert.deepEqual(next.pages["/forgot-password"].locators, { email: "#old-email" });
  assert.equal(next.pages["/forgot-password"].fields["forgot-email-input"], '[name="forgot-email-input"]');
});

test("computeLocatorPromotion never lets primary also appear as its own fallback", () => {
  const next = computeLocatorPromotion(
    {},
    {
      pagePath: "/x",
      bucket: "locators",
      name: "n",
      primary: "  #a  ",
      fallbacks: ["#a", "#b", "#a", "  #b  "],
      userId: "user_1",
    }
  );
  const fb = next.locatorFallbacks["/x"].locators.n;
  assert.equal(fb.primary, "#a");
  assert.deepEqual(fb.fallbacks, ["#b"]);
});

function entry(overrides?: Partial<Record<string, unknown>>) {
  return {
    projectId: "project_1",
    pagePath: "/forgot-password",
    bucket: "fields" as const,
    name: "forgot-email-input",
    selector: "[name=\"forgot-email-input\"]",
    fallbacks: [],
    matchCount: 1,
    ...overrides,
  };
}

test("selectPromotableEntries promotes an entry whose test case passed on the rerun", () => {
  const attempts = [{ id: "attempt_1", testCaseId: "case_1", fixDetails: { pendingLocatorPromotion: [entry()] } }];
  const result = selectPromotableEntries(attempts, new Set(["case_1"]));
  assert.equal(result.length, 1);
  assert.equal(result[0].healingAttemptId, "attempt_1");
  assert.equal(result[0].entry.name, "forgot-email-input");
});

test("selectPromotableEntries excludes an attempt whose test case did NOT pass on the rerun", () => {
  // This is the exact-test invariant: a targeted rerun that only re-executed some tests
  // must not promote fixes for a test it didn't itself re-verify, even if that test's
  // healing attempt succeeded on the original run.
  const attempts = [{ id: "attempt_1", testCaseId: "case_1", fixDetails: { pendingLocatorPromotion: [entry()] } }];
  const result = selectPromotableEntries(attempts, new Set(["case_2"]));
  assert.equal(result.length, 0);
});

test("selectPromotableEntries excludes non-unique (matchCount !== 1) entries even when the test case passed", () => {
  // Defense in depth: this check is independent of live-selector-probe-rule.ts's own
  // matchCount filter - shared-state mutation should never trust its producer completely.
  const attempts = [
    { id: "attempt_1", testCaseId: "case_1", fixDetails: { pendingLocatorPromotion: [entry({ matchCount: 2 })] } },
  ];
  const result = selectPromotableEntries(attempts, new Set(["case_1"]));
  assert.equal(result.length, 0);
});

test("selectPromotableEntries excludes matchCount: null entries", () => {
  const attempts = [
    { id: "attempt_1", testCaseId: "case_1", fixDetails: { pendingLocatorPromotion: [entry({ matchCount: null })] } },
  ];
  const result = selectPromotableEntries(attempts, new Set(["case_1"]));
  assert.equal(result.length, 0);
});

test("selectPromotableEntries handles attempts with no pendingLocatorPromotion (e.g. rule-based, non-Tier-2 fixes) safely", () => {
  const attempts = [
    { id: "attempt_1", testCaseId: "case_1", fixDetails: { rule: "missing-nav-locator" } },
    { id: "attempt_2", testCaseId: "case_2", fixDetails: null },
    { id: "attempt_3", testCaseId: "case_3", fixDetails: undefined },
  ];
  const result = selectPromotableEntries(attempts, new Set(["case_1", "case_2", "case_3"]));
  assert.equal(result.length, 0);
});

test("selectPromotableEntries handles multiple attempts and multiple entries per attempt independently", () => {
  const attempts = [
    {
      id: "attempt_1",
      testCaseId: "case_1",
      fixDetails: {
        pendingLocatorPromotion: [
          entry({ name: "email-field", matchCount: 1 }),
          entry({ name: "ambiguous-button", bucket: "locators", matchCount: 3 }),
        ],
      },
    },
    {
      id: "attempt_2",
      testCaseId: "case_2",
      fixDetails: { pendingLocatorPromotion: [entry({ name: "other-field", matchCount: 1 })] },
    },
  ];
  // only case_1's rerun result is known to have passed; case_2 wasn't re-verified
  const result = selectPromotableEntries(attempts, new Set(["case_1"]));
  assert.equal(result.length, 1);
  assert.equal(result[0].entry.name, "email-field");
});
