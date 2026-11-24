import test from "node:test";
import assert from "node:assert/strict";
import ts from "typescript";
import { generateQeSuite, submitLabelFor, QE_AUTH_ENV } from "./qe-codegen.js";
import { buildQePlan, gateSuiteTests, testTitlesInSpec } from "../../lib/qe-plan.js";
import { buildStoryRecord, computeCrawlKnowledgeUpdate, upsertStory } from "../../lib/app-knowledge.js";
import { normalizeApplicationModel } from "../../lib/application-model.js";
import { prisma } from "../../prisma.js";
import { encryptSecret } from "../../lib/crypto.js";
import { resolveCredentialEnv, isCredentialRef, credentialRefExists } from "../../lib/qe-credentials.js";

const T0 = "2026-11-23T10:00:00.000Z";

// Bes-shaped knowledge from the live crawls.
function besStore() {
  let store = computeCrawlKnowledgeUpdate(normalizeApplicationModel(null), {
    scans: [
      { url: "https://www.bes-app.com/", status: 200, title: "Landing", buttons: ['button:has-text("Sign In")', 'button:has-text("Create Account")'] },
      { url: "https://www.bes-app.com/register", status: 200, title: "Register", buttons: ['button:has-text("Sign In")', 'button:has-text("Create Account")', 'button:has-text("Continue to Contact")', 'button:has-text("Privacy Policy")'],
        forms: [{ fields: [{ name: "your-name", placeholder: "Your name" }, { name: "auth-email-input", type: "email" }, { name: "auth-password-input", type: "password" }] }] },
      { url: "https://www.bes-app.com/login", status: 200, title: "Login", buttons: ['button:has-text("Sign In")', 'button:has-text("Create Account")'], forms: [{ fields: [{ name: "e", type: "email" }, { name: "p", type: "password" }] }] },
    ],
    apiCalls: [],
    redirects: [{ url: "https://www.bes-app.com/profile", finalUrl: "https://www.bes-app.com/", status: 200 }],
    observedAt: T0,
  }).next;
  store.pages["/register"].forms = [{ selector: "form", signature: "s", fields: [{ name: "your-name", required: true }, { name: "auth-email-input", type: "email", required: true }, { name: "auth-password-input", type: "password", required: true }] }];
  store = upsertStory(store, buildStoryRecord(`As a new Bes user
I want to create an account
- The registration page shows email and password fields
- Submitting with an invalid email shows a validation error
- The Create Account option is reachable from the landing page
- I receive a welcome SMS after registering`, store, T0));
  return store;
}

function plan(store = besStore()) {
  return buildQePlan({
    jobId: "job-b4", projectId: "p-1", baseUrl: "https://www.bes-app.com", now: T0, store,
    coverageRoutes: ["/", "/register", "/profile"], failing: [], existingTests: [{ title: "Page loads: /" }], apiTestPaths: [],
    generatorCases: [{ title: "Page loads: /", page: "/" }],
  });
}

const file = (r: ReturnType<typeof generateQeSuite>, p: string) => r.files.find((f) => f.path === p)?.content ?? "";

test("plan scenarios become organized specs with fixtures and page objects, each test mapped to its scenario and criteria", () => {
  const store = besStore();
  const p = plan(store);
  const r = generateQeSuite(p, store, { hasCredentials: false });
  const paths = r.files.map((f) => f.path).sort();
  assert.ok(paths.includes("qe/fixtures.ts"));
  assert.ok(paths.includes("qe/register.qe.spec.ts"));
  assert.ok(paths.includes("qe/pages/register.page.ts"));
  assert.ok(paths.includes("qe/qe-manifest.json"));
  for (const t of r.tests) {
    const scenario = p.scenarios.find((s) => s.id === t.scenarioId)!;
    assert.equal(t.testTitle, `${scenario.title} [qe:${scenario.id}]`);
    assert.ok(file(r, t.file).includes(JSON.stringify(t.testTitle)), `${t.testTitle} is in ${t.file}`);
    assert.ok(file(r, t.file).includes(`traceScenario(${JSON.stringify(t.scenarioId)}`));
  }
  const ac = r.tests.find((t) => t.title === "AC: The registration page shows email and password fields")!;
  assert.equal(ac.criteria[0].criterionId, "ac1");
  assert.ok(file(r, ac.file).includes('"criterionId":"ac1"'), "acceptance criterion annotated on the test");
  assert.equal(submitLabelFor(store.pages["/register"]), "Continue to Contact", "the observed submit, not a mode toggle");
});

test("assertions verify the objective, not just navigation", () => {
  const store = besStore();
  const r = generateQeSuite(plan(store), store, { hasCredentials: false });
  const reg = file(r, "qe/register.qe.spec.ts");
  assert.match(reg, /not-an-email/);
  assert.match(reg, /checkValidity\(\)/, "invalid email: the email input itself must be invalid (or email feedback shown)");
  assert.match(reg, /toHaveAttribute\('type', 'password'\)/);
  assert.match(reg, /\^https:/);
  assert.match(reg, /po\.field\("email"\).*toBeVisible|toBeVisible[\s\S]*po\.field\("email"\)/, "criterion: observed fields asserted visible");
  const profile = file(r, "qe/profile.qe.spec.ts");
  assert.match(profile, /not\.toHaveURL/, "access control: the protected route must not be reached");
  const home = file(r, "qe/home.qe.spec.ts");
  assert.match(home, /po\.action\("Create Account"\)\.click\(\)/);
  assert.match(home, /toHaveURL\(onPath\(".*register/, "workflow criterion: clicking leads to an observed destination (pathname match)");
  assert.match(file(r, "qe/fixtures.ts"), /export const onPath = .*url\.pathname/, "route assertions match the pathname, not the full URL (live Bes regression)");
  for (const f of r.files.filter((x) => x.path.endsWith(".ts"))) {
    const out = ts.transpileModule(f.content, { reportDiagnostics: true, compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
    assert.deepEqual(out.diagnostics?.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")) ?? [], [], `${f.path} must be valid TypeScript`);
  }
});

test("blocked scenarios are reported, never fabricated or passed", () => {
  const store = besStore();
  const r = generateQeSuite(plan(store), store, { hasCredentials: false });
  const reasons = new Map(r.notGenerated.map((n) => [n.title, n.reason]));
  assert.match(reasons.get("Exercise /profile as a signed-in user")!, /authentication/i);
  assert.match(reasons.get("AC: I receive a welcome SMS after registering")!, /No element referenced/);
  assert.ok(!r.tests.some((t) => t.requiresAuth), "no authenticated tests without approved credentials");
  assert.equal(r.tests.filter((t) => t.file === "qe/profile.qe.spec.ts").length, 1, "only the observed access-control check for /profile");
  const manifest = JSON.parse(file(r, "qe/qe-manifest.json"));
  assert.equal(manifest.notGenerated.length, r.notGenerated.length);
});

test("approved credentials: authenticated tests use an isolated session, referenced by env NAME only, without traces", () => {
  const store = besStore();
  const r = generateQeSuite(plan(store), store, { hasCredentials: true });
  const auth = r.tests.find((t) => t.title === "Exercise /profile as a signed-in user")!;
  assert.equal(auth.requiresAuth, true);
  const spec = file(r, auth.file);
  assert.match(spec, /async \(\{ authPage \}\)/);
  assert.match(spec, /qe\.use\(\{ trace: 'off', video: 'off' \}\)/);
  assert.match(spec, /expect\(authPage\)\.toHaveURL/);
  const fx = file(r, "qe/fixtures.ts");
  assert.ok(fx.includes(`process.env.${QE_AUTH_ENV.email}`) && fx.includes(`process.env.${QE_AUTH_ENV.password}`));
  assert.match(fx, /chromium\.launch\(\)/, "sign-in happens in a separate, untraced browser");
  assert.match(fx, /storageState: qeAuthState/, "tests get fresh contexts from the resulting session");
  for (const f of r.files) assert.doesNotMatch(f.content, /qe-secret-value|hunter2/, "no credential values anywhere in generated output");
});

test("generated tests stay behind the side-effect approval gate", () => {
  const store = besStore();
  const p = plan(store);
  const r = generateQeSuite(p, store, { hasCredentials: false });
  const updated = { ...p, scenarios: p.scenarios.map((s) => { const t = r.tests.find((x) => x.scenarioId === s.id); return t ? { ...s, execution: { mode: "generated_now" as const, testTitle: t.testTitle } } : s; }) };
  const titles = r.files.filter((f) => f.path.endsWith(".spec.ts")).flatMap((f) => testTitlesInSpec(f.content));
  assert.equal(titles.length, r.tests.length, "the gate can read every generated qe(...) test");
  const gated = gateSuiteTests(updated, titles, store);
  assert.ok(gated.some((g) => /Script\/markup input on \/register/.test(g.title)), "active security probes need approval");
  assert.ok(!gated.some((g) => /Password input on \/register is masked/.test(g.title)), "read-only checks are not gated");
});

test("credentials resolve from encrypted project secrets by reference, only for the test process", async (t) => {
  const project = await prisma.project.findFirst({ orderBy: { createdAt: "asc" } });
  assert.ok(project, "requires a local project row");
  const keys = { emailKey: `QE_B4_TEST_EMAIL_${Date.now()}`, passwordKey: `QE_B4_TEST_PASSWORD_${Date.now()}` };
  await prisma.projectSecret.createMany({ data: [
    { projectId: project!.id, name: "qe email", key: keys.emailKey, value: encryptSecret("qa@example.test") },
    { projectId: project!.id, name: "qe password", key: keys.passwordKey, value: encryptSecret("qe-secret-value") },
  ] });
  t.after(() => prisma.projectSecret.deleteMany({ where: { projectId: project!.id, key: { in: [keys.emailKey, keys.passwordKey] } } }));

  assert.equal(isCredentialRef(keys), true);
  assert.equal(isCredentialRef({ emailKey: "a", passwordKey: "b", loginPath: "https://evil" }), false, "login path must be relative");
  assert.equal(await credentialRefExists(project!.id, keys), true);
  assert.equal(await credentialRefExists(project!.id, { ...keys, passwordKey: "NOPE" }), false);
  const env = await resolveCredentialEnv(project!.id, { ...keys, loginPath: "/login" }, QE_AUTH_ENV);
  assert.deepEqual(env, { [QE_AUTH_ENV.email]: "qa@example.test", [QE_AUTH_ENV.password]: "qe-secret-value", [QE_AUTH_ENV.loginPath]: "/login" });
  assert.deepEqual(await resolveCredentialEnv(project!.id, { ...keys, emailKey: "MISSING" }, QE_AUTH_ENV), {}, "unresolvable -> no auth (tests skip), never a partial login");
  assert.deepEqual(await resolveCredentialEnv(project!.id, "not-a-ref", QE_AUTH_ENV), {});
});
