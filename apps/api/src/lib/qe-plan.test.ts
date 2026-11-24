import test from "node:test";
import assert from "node:assert/strict";
import { buildQePlan, classifyRisk, gateSuiteTests, gatedTestTitles, grepInvertFor, objectiveForTest, testTitlesInSpec, type PlanInputs } from "./qe-plan.js";
import { buildStoryRecord, computeCrawlKnowledgeUpdate, upsertStory } from "./app-knowledge.js";
import { normalizeApplicationModel } from "./application-model.js";

const T0 = "2026-11-23T10:00:00.000Z";

// Bes-shaped knowledge (from the live B2 crawl).
function besStore() {
  let store = computeCrawlKnowledgeUpdate(normalizeApplicationModel(null), {
    scans: [
      { url: "https://www.bes-app.com/", status: 200, title: "Landing", buttons: ['button:has-text("Sign In")', 'button:has-text("Create Account")', 'button:has-text("Emergency Help")'] },
      { url: "https://www.bes-app.com/register", status: 200, title: "Register", buttons: ['button:has-text("Create Account")', 'button:has-text("Continue to Contact")'],
        forms: [{ fields: [{ name: "your-name", placeholder: "Your name" }, { name: "auth-email-input", type: "email" }, { name: "auth-password-input", type: "password" }] }] },
      { url: "https://www.bes-app.com/forgot-password", status: 200, title: "ForgotPassword", buttons: ['button:has-text("Send reset code")'], forms: [{ fields: [{ name: "email", type: "email" }] }] },
    ],
    apiCalls: [{ method: "GET", origin: "https://api.bes-app.com", path: "/v1/resources/7", status: 200, route: "/" }],
    redirects: [{ url: "https://www.bes-app.com/profile", finalUrl: "https://www.bes-app.com/", status: 200 }],
    observedAt: T0,
  }).next;
  // Forms merge (as discovery writes it) - required flags come from observed DOM.
  store.pages["/register"].forms = [{ selector: "form", signature: "s", fields: [{ name: "your-name", required: true }, { name: "auth-email-input", type: "email", required: true }, { name: "auth-password-input", type: "password", required: true }] }];
  store = upsertStory(store, buildStoryRecord(`As a new Bes user
I want to create an account
- The registration page shows email and password fields
- Submitting with an invalid email shows a validation error
- I receive a welcome SMS after registering`, store, T0));
  return store;
}

function inputs(over: Partial<PlanInputs> = {}): PlanInputs {
  return {
    jobId: "job-1", projectId: "p-1", baseUrl: "https://www.bes-app.com", now: T0,
    store: besStore(),
    coverageRoutes: ["/", "/register", "/profile"],
    failing: [{ route: "/register", title: "Form submits – /register", lastFailureMessage: "element(s) not found", lastRunAt: T0 }],
    existingTests: [{ title: "Page loads: /" }, { title: "Form submits – /register" }, { title: "Navigate /profile → /emergency" }],
    apiTestPaths: [],
    generatorCases: [{ title: "Page loads: /", page: "/" }, { title: "Form submits – /register", page: "/register" }, { title: "Page loads: /forgot-password", page: "/forgot-password" }],
    ...over,
  };
}

test("side effects are detected from what the test acts on", () => {
  assert.equal(classifyRisk({ route: "/register", acts: true, labels: ["Create Account"], category: "positive" }).level, "sensitive");
  assert.equal(classifyRisk({ route: "/forgot-password", acts: true, labels: ["Send reset code"], category: "positive" }).level, "sensitive");
  const sos = classifyRisk({ route: "/emergency", acts: true, labels: ["Alert trusted contacts", "Share location"], category: "positive" });
  assert.equal(sos.level, "destructive");
  assert.match(sos.reasons.join(" "), /real-world action/);
  assert.equal(classifyRisk({ route: "/settings", acts: true, labels: ["Delete my data"], category: "positive" }).level, "destructive");
  assert.equal(classifyRisk({ route: "/register", acts: false, labels: ["Create Account"], category: "positive" }).level, "safe", "loading a page has no side effects");
  assert.equal(classifyRisk({ route: "/login", acts: true, labels: ["Sign In"], category: "negative" }).level, "safe");
  assert.equal(classifyRisk({ route: "/x", acts: false, labels: [], category: "security", active: true }).level, "sensitive", "active probes need approval");
});

test("plan covers every relevant category, each scenario mapped to evidence or an explicit criterion", () => {
  const plan = buildQePlan(inputs());
  const cats = plan.summary.byCategory;
  for (const c of ["positive", "negative", "security", "integration"] as const) assert.ok(cats[c] > 0, `${c} scenarios expected`);
  assert.ok(plan.scenarios.some((s) => s.title === "An invalid email on /register is rejected"));
  assert.ok(plan.scenarios.some((s) => s.title === "Submitting /register with required fields empty is rejected"));
  assert.ok(plan.scenarios.some((s) => s.title === "Password input on /register is masked"));
  assert.ok(plan.scenarios.some((s) => s.title === "Credentials on /register are only sent over HTTPS"));
  assert.ok(plan.scenarios.some((s) => s.category === "integration" && s.title.startsWith("GET /v1/resources/:id")));
  for (const s of plan.scenarios) assert.ok(s.evidence.length > 0, `scenario without evidence: ${s.title}`);
  const ac = plan.scenarios.find((s) => s.title === "AC: Submitting with an invalid email shows a validation error")!;
  assert.equal(ac.category, "negative");
  assert.equal(ac.criteria[0].criterionId, "ac2");
  assert.equal(ac.objective, "Submitting with an invalid email shows a validation error", "the objective IS the criterion text");
});

test("auth-blocked areas: observed access control is tested, functionality behind it is never invented", () => {
  const plan = buildQePlan(inputs());
  const deny = plan.scenarios.find((s) => s.title === "Anonymous access to /profile is denied (lands on /)")!;
  assert.equal(deny.status, "ready");
  assert.equal(deny.category, "security");
  const blocked = plan.scenarios.find((s) => s.title === "Exercise /profile as a signed-in user")!;
  assert.equal(blocked.status, "blocked_auth");
  assert.equal(blocked.execution.mode, "not_executable");
  assert.match(blocked.objective, /not assumed/);
  assert.equal(plan.scenarios.filter((s) => s.route === "/profile").length, 2, "nothing else is planned for an unobserved area");
  const sms = plan.scenarios.find((s) => s.title.includes("welcome SMS"))!;
  assert.equal(sms.status, "blocked_unverifiable");
  assert.equal(sms.execution.mode, "not_executable");
});

test("existing vs missing coverage, failing areas first, destructive tests flagged for approval", () => {
  const plan = buildQePlan(inputs());
  const byTitle = (t: string) => plan.scenarios.find((s) => s.title === t)!;
  assert.equal(byTitle("Page loads: /").coverage, "existing");
  assert.equal(byTitle("Page loads: /forgot-password").coverage, "missing");
  assert.equal(byTitle("An invalid email on /register is rejected").coverage, "missing");
  const failing = byTitle("Re-verify failing test: Form submits – /register");
  assert.equal(failing.priority.breakdown.previouslyFailing, 30);
  assert.equal(failing.priority.tier, "P1");
  const submit = byTitle("Form submits – /register");
  assert.equal(submit.risk.level, "sensitive");
  assert.equal(plan.summary.needsApproval >= 1, true);
  assert.deepEqual(gatedTestTitles(plan).map((g) => g.title), ["Form submits – /register"]);
  assert.equal(byTitle("Page loads: /").risk.level, "safe");
  const ready = plan.scenarios.filter((s) => s.status === "ready");
  for (let i = 1; i < ready.length; i++) assert.ok(ready[i - 1].priority.score >= ready[i].priority.score, "ready scenarios are risk-ordered");
  assert.ok(plan.scenarios.findIndex((s) => s.status !== "ready") >= ready.length, "blocked items come after executable ones");
});

test("plan is stable and its objectives are retrievable for generation and repair", () => {
  const a = buildQePlan(inputs());
  const b = buildQePlan(inputs());
  assert.deepEqual(a.scenarios.map((s) => s.id), b.scenarios.map((s) => s.id));
  assert.match(objectiveForTest(a, "Page loads: /forgot-password")!.objective, /renders successfully/);
  assert.equal(objectiveForTest(a, "nope"), null);
});

test("the whole suite under test is gated - including tests from earlier runs the plan didn't produce", () => {
  const plan = buildQePlan(inputs());
  const titles = testTitlesInSpec(`test('Page loads: /login', async () => {}); test("Form submits – /forgot-password", async () => {}); test(\`Navigate /profile → /emergency\`, async () => {}); test('Form submits – /register', async () => {})`);
  assert.deepEqual(titles, ["Page loads: /login", "Form submits – /forgot-password", "Navigate /profile → /emergency", "Form submits – /register"]);
  const gated = gateSuiteTests(plan, titles, besStore()).map((g) => g.title).sort();
  assert.deepEqual(gated, ["Form submits – /forgot-password", "Form submits – /register"]);
  assert.equal(grepInvertFor(["Form submits – /register", "a.b (c)"]), "Form submits – /register|a\\.b \\(c\\)");
  assert.equal(grepInvertFor([]), undefined);
});

test("legal links and unrelated toggles don't make a safe action look destructive (live Bes false positive)", () => {
  // Real Bes /register and /login labels from the crawl.
  const reg = classifyRisk({ route: "/register", acts: true, labels: ["Sign In", "Create Account", "Continue to Contact", "Terms of Service", "Privacy Policy", "Data Deletion"], category: "positive" });
  assert.equal(reg.level, "sensitive", "registering creates an account - still needs approval");
  assert.ok(!reg.reasons.some((r) => /Data Deletion/.test(r)));
  const login = classifyRisk({ route: "/login", acts: true, labels: ["Sign In", "Create Account", "Forgot password?", "Data Deletion"], category: "positive" });
  assert.equal(login.level, "safe", "signing in has no side effects to gate");
  assert.equal(classifyRisk({ route: "/account/delete", acts: true, labels: ["Privacy Policy"], category: "positive" }).level, "destructive", "a destructive route is still caught");
});
