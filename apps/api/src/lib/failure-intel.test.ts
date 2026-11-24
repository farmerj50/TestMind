import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyFailure, decideRepair, locatorLabel, receivedUrl, repairPreservesObjective,
  recordInvestigationsInStore, recordRepairOutcomeInStore, type ClassifyInput,
} from "./failure-intel.js";
import { investigateFailure } from "./investigator.js";
import { computeCrawlKnowledgeUpdate } from "./app-knowledge.js";
import { normalizeApplicationModel } from "./application-model.js";

const T0 = "2026-11-23T10:00:00.000Z";
const store = computeCrawlKnowledgeUpdate(normalizeApplicationModel(null), {
  scans: [
    { url: "https://www.bes-app.com/", status: 200, title: "Landing", buttons: ['button:has-text("Sign In")', 'button:has-text("Create Account")', 'button:has-text("Continue with Email")'] },
    { url: "https://www.bes-app.com/register", status: 200, buttons: ['button:has-text("Continue to Contact")'], forms: [{ fields: [{ name: "e", type: "email" }] }] },
  ],
  apiCalls: [],
  redirects: [{ url: "https://www.bes-app.com/profile", finalUrl: "https://www.bes-app.com/", status: 200 }],
  observedAt: T0,
}).next;

function input(over: Partial<ClassifyInput> & { message: string | null }): ClassifyInput {
  return {
    testResultId: "tr-1", testCaseId: "tc-1", testTitle: "t", investigator: investigateFailure({ message: over.message }),
    analyzer: null, network: { serverErrors: [], requestFailed: [] }, attachments: [], scenario: null, route: "/", page: store.pages["/"], ...over,
  };
}

// Real messages captured from Bes / TestMind runs.
const GET_STARTED = `Error: expect(locator).toBeVisible() failed Locator: locator('button:has-text("Get Started")') Expected: visible Timeout: 5000ms Error: element(s) not found`;
const FULL_URL_BUG = `Error: expect(page).toHaveURL(expected) failed\nExpected pattern: /^\\/?$/\nReceived string: "https://www.bes-app.com/"\nTimeout: 5000ms`;

test("an objective-required element that is no longer observed is a suspected product defect, escalated - never rewritten", () => {
  const inv = classifyFailure(input({
    message: GET_STARTED, testTitle: "AC: Get Started button is visible",
    scenario: { id: "s1", kind: "criterion", objective: "The Get Started button is visible on the landing page", criteria: [{ text: "The Get Started button is visible on the landing page" }] },
  }));
  assert.equal(locatorLabel(GET_STARTED), "Get Started");
  assert.equal(inv.category, "product_defect");
  assert.equal(inv.cause, "objective_unmet");
  assert.equal(inv.escalate, true);
  assert.equal(inv.repairable, false);
  assert.match(inv.explanation, /not among the elements observed/);
  assert.equal(decideRepair(inv, { autonomyAllowsRepair: true, sideEffectsApproved: true }).action, "escalate");
});

test("a stale locator for an element that IS still observed is a safe, high-confidence selector repair", () => {
  const msg = `Error: expect(locator).toBeVisible() failed Locator: getByRole('button', { name: 'Continue with Email' }) Error: element(s) not found`;
  const inv = classifyFailure(input({ message: msg, scenario: { id: "s2", kind: "criterion", objective: "Continue with Email is offered", criteria: [] } }));
  assert.equal(inv.category, "test_defect");
  assert.equal(inv.cause, "broken_selector");
  assert.equal(inv.confidence, "high");
  assert.equal(decideRepair(inv, { autonomyAllowsRepair: true, sideEffectsApproved: true }).action, "auto_repair");
  assert.equal(decideRepair(inv, { autonomyAllowsRepair: false, sideEffectsApproved: true }).action, "hold", "repair needs authorization");
  assert.equal(decideRepair(inv, { autonomyAllowsRepair: true, sideEffectsApproved: false }).action, "hold", "no re-run of unapproved side effects");
});

test("redirects and auth: stale signed-out assumptions vs. an access-control regression", () => {
  const stale = classifyFailure(input({ message: GET_STARTED, testTitle: "Navigate /profile → /emergency", route: "/profile", page: store.pages["/profile"] }));
  assert.equal(stale.category, "test_defect");
  assert.equal(stale.cause, "auth_required");
  assert.equal(stale.repairable, false, "automation must not change what this test verifies");
  assert.equal(stale.escalate, true);
  assert.ok(stale.evidence.some((e) => e.kind === "observation" && /redirected/.test(e.detail)));

  const breach = classifyFailure(input({
    message: `Error: expect(page).not.toHaveURL(expected) failed\nExpected pattern: not /^\\/profile\\/?$/\nReceived string: "https://www.bes-app.com/profile"`,
    route: "/profile", page: store.pages["/profile"], scenario: { id: "s3", kind: "access_denied", objective: "A signed-out visitor requesting /profile must not reach its content", criteria: [] },
  }));
  assert.equal(breach.category, "product_defect");
  assert.equal(breach.confidence, "high");
  assert.match(breach.explanation, /access-control regression/);

  const login = classifyFailure(input({ message: `Error: expect(locator).toBeVisible() failed\nReceived string: "https://app.test/login?next=/x"`, route: "/settings", page: null }));
  assert.equal(login.cause, "auth_required");
  assert.equal(login.category, "blocked_inconclusive");
});

test("the B4 full-URL assertion bug is recognized as a test defect, not a product failure", () => {
  assert.equal(receivedUrl(FULL_URL_BUG)?.pathname, "/");
  const inv = classifyFailure(input({ message: FULL_URL_BUG, route: "/contacts", page: null, scenario: { id: "s4", kind: "access_denied", objective: "denied", criteria: [] } }));
  assert.equal(inv.category, "test_defect");
  assert.equal(inv.cause, "assertion_form");
  assert.equal(inv.confidence, "high");
  assert.equal(inv.repairable, false, "regenerate rather than let self-heal touch the assertion");
});

test("environment, server errors, objective mismatches and empty evidence", () => {
  const env = classifyFailure(input({ message: "page.goto: net::ERR_CONNECTION_REFUSED at https://www.bes-app.com/", network: { serverErrors: [], requestFailed: ["net::ERR_CONNECTION_REFUSED"] } }));
  assert.equal(env.category, "environment");
  assert.equal(env.confidence, "high");
  const s5 = classifyFailure(input({ message: "Error: expect(received).toBeLessThan(expected) Expected: < 400 Received: 502", network: { serverErrors: [502], requestFailed: [] } }));
  assert.equal(s5.category, "blocked_inconclusive", "a 5xx alone does not distinguish app/dependency/proxy");
  assert.equal(s5.cause, "server_error");
  const unmet = classifyFailure(input({ message: `Error: expect(page).toHaveURL(expected) failed\nExpected pattern: /^\\/register$/\nReceived string: "https://www.bes-app.com/about"`, route: "/", scenario: { id: "s6", kind: "criterion", objective: "The Create Account option is reachable from the landing page", criteria: [] } }));
  assert.equal(unmet.category, "product_defect");
  assert.equal(unmet.cause, "objective_unmet");
  const none = classifyFailure(input({ message: null }));
  assert.equal(none.category, "blocked_inconclusive");
  assert.equal(none.confidence, "low");
});

test("repairs may change locators, never the objective", () => {
  const original = `import { qe, expect } from './fixtures';
qe('Create Account reachable [qe:abc]', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Create Account' })).toBeVisible();
  await expect(page.getByText('Email')).toBeVisible();
});`;
  const selectorOnly = original.replace("page.getByRole('button', { name: 'Create Account' })", "page.locator('[data-testid=\"landing-create-account-btn\"]').filter({ hasText: 'Create Account' })");
  assert.deepEqual(repairPreservesObjective(original, selectorOnly), { ok: true, reasons: [] });

  const cases: Array<[string, RegExp]> = [
    [original.replace("  await expect(page.getByText('Email')).toBeVisible();\n", ""), /removed assertions|stopped asserting/],
    [original.replace("name: 'Create Account'", "name: 'Continue with Email'"), /stopped asserting "create account"/],
    [original.replace("qe('Create Account", "qe.skip('Create Account"), /skip/],
    [original.replace("getByText('Email')).toBeVisible()", "getByText('Email')).not.toBeVisible()"), /inverted/],
    [original.replace("[qe:abc]", "[qe:xyz]"), /renamed/],
  ];
  for (const [repaired, why] of cases) {
    const g = repairPreservesObjective(original, repaired);
    assert.equal(g.ok, false);
    assert.match(g.reasons.join(" "), why);
  }
});

test("investigations and repair outcomes are recorded in the Brain with bounded history; only product defects become defect records", () => {
  const product = classifyFailure(input({ message: GET_STARTED, scenario: { id: "s1", kind: "criterion", objective: "Get Started button is visible", criteria: [] } }));
  const selector = { ...classifyFailure(input({ message: `getByRole('button', { name: 'Sign In' }) element(s) not found` })), testCaseId: "tc-2", testResultId: "tr-2" };
  let s = normalizeApplicationModel(null);
  for (let i = 0; i < 7; i++) s = recordInvestigationsInStore(s, [product, selector], `run-${i}`, `2026-11-2${i}T00:00:00.000Z`);
  assert.equal(s.investigations!["tc-1"].history.length, 5);
  assert.equal(s.investigations!["tc-1"].latest.runId, "run-6");
  assert.deepEqual(Object.keys(s.defects!), ["tc-1"]);
  assert.equal(s.defects!["tc-1"].occurrences, 7);
  assert.equal(s.defects!["tc-1"].status, "needs_review");
  s = recordRepairOutcomeInStore(s, "tc-2", { status: "repaired_verified", detail: "ok", at: T0 });
  assert.equal(s.investigations!["tc-2"].latest.repair?.status, "repaired_verified");
  assert.ok(normalizeApplicationModel(s).investigations && normalizeApplicationModel(s).defects, "records survive normalization");
  assert.equal("investigations" in normalizeApplicationModel(null), false);
});
