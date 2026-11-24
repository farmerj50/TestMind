import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildStoryRecord,
  classifyPageAccess,
  computeCrawlKnowledgeUpdate,
  extractDeclaredRoutes,
  incrementalSeedRoutes,
  mapCriterionToEvidence,
  parseUserStory,
  pathMatches,
  recommendNextTests,
  refreshStoryEvidence,
  templateApiPath,
  upsertStory,
  type KnowledgeInputs,
} from "./app-knowledge.js";
import { computeApplicationModelUpdate, normalizeApplicationModel } from "./application-model.js";
import { inspectRepository } from "./app-knowledge-store.js";

const T0 = "2026-11-20T10:00:00.000Z";
const T1 = "2026-11-23T10:00:00.000Z";
const empty = () => normalizeApplicationModel(null);

const landing = { url: "https://app.test/", status: 200, title: "Bes", headings: ["Your safe space"], buttons: ["Get Started", "Sign In"], controls: [{ label: "Create Account" }] };
const register = { url: "https://app.test/register", status: 200, headings: ["Create your account"], buttons: ["Continue to Contact"], forms: [{ fields: [{ name: "email", label: "Email", type: "email" }, { name: "password", label: "Password", type: "password" }] }] };
const profile = { url: "https://app.test/profile", finalUrl: "https://app.test/login?next=/profile", status: 200 };

test("page access is classified from observed responses only", () => {
  assert.equal(classifyPageAccess({ url: "https://a/x", status: 403 }, T0).state, "auth_required");
  const redirected = classifyPageAccess(profile, T0);
  assert.equal(redirected.state, "auth_required");
  assert.equal(redirected.finalRoute, "/login");
  assert.match(redirected.evidence, /redirected to \/login/);
  assert.equal(classifyPageAccess(register, T0).state, "login_page", "a password field marks an auth entry page");
  assert.equal(classifyPageAccess({ url: "https://a/gone", status: 404 }, T0).state, "unreachable");
  const pub = classifyPageAccess(landing, T0, "run-1");
  assert.equal(pub.state, "public");
  assert.equal(pub.source, "crawl");
  assert.equal(pub.observedAt, T0);
  assert.equal(pub.runId, "run-1");
});

test("API paths are templated so ids don't create duplicate endpoints", () => {
  assert.equal(templateApiPath("/api/users/42"), "/api/users/:id");
  assert.equal(templateApiPath("/api/notes/3f2a1c9e-1b2c-4d5e-8f90-a1b2c3d4e5f6/tags"), "/api/notes/:id/tags");
  assert.equal(templateApiPath("/api/health"), "/api/health");
  assert.ok(pathMatches("/api/users/:id", "/api/users/{userId}"));
  assert.ok(pathMatches("/api/users/:id", "https://host/api/users/7?x=1"));
  assert.ok(!pathMatches("/api/users/:id", "/api/users"));
});

test("crawl knowledge: every crawled page becomes a provenance-stamped fact; APIs merge without disturbing spec imports", () => {
  let store = empty();
  store = { ...store, apis: { "GET /api/spec-only": { method: "GET", path: "/api/spec-only", signature: "s", firstSeenAt: T0, lastSeenAt: T0, lastChangedAt: T0, consecutiveMisses: 0 } } };
  const first = computeCrawlKnowledgeUpdate(store, {
    scans: [landing, register, profile],
    apiCalls: [
      { method: "GET", origin: "https://api.app.test", path: "/v1/resources/12", status: 200, route: "/" },
      { method: "GET", origin: "https://api.app.test", path: "/v1/resources/13", status: 500, route: "/" },
      { method: "OPTIONS", origin: "https://api.app.test", path: "/v1/resources/12", status: 204, route: "/" },
      { method: "POST", origin: "https://api.app.test", path: "/v1/auth/session", status: 401, route: "/register" },
    ],
    thirdPartyHosts: { "www.google-analytics.com": 3 },
    observedAt: T0, runId: "run-1",
  });
  const p = first.next.pages;
  assert.deepEqual(Object.keys(p).sort(), ["/", "/profile", "/register"], "formless pages are recorded too");
  assert.deepEqual(p["/"].observed?.actions, ["Create Account", "Get Started", "Sign In"]);
  assert.deepEqual(p["/register"].observed?.fields, ["Email", "Password"]);
  assert.equal(p["/profile"].access?.state, "auth_required");
  assert.deepEqual(first.diff.authRequired, ["/profile"]);
  const api = first.next.apis["GET /v1/resources/:id"];
  assert.equal(api.source, "crawl");
  assert.deepEqual(api.statuses, [200, 500]);
  assert.deepEqual(api.observedOnRoutes, ["/"]);
  assert.ok(!first.next.apis["OPTIONS /v1/resources/:id"], "CORS preflights are not endpoints");
  assert.deepEqual(first.diff.thirdPartyHosts, ["www.google-analytics.com"]);
  assert.equal(first.next.apis["GET /api/spec-only"].consecutiveMisses, 0, "spec-imported APIs are never 'missed' by a crawl");

  // Next cycle crawls only /register: the resources API (seen on /) is not evidence of disappearance.
  const second = computeCrawlKnowledgeUpdate(first.next, { scans: [register], apiCalls: [], observedAt: T1 });
  assert.equal(second.next.apis["GET /v1/resources/:id"].consecutiveMisses, 0);
  assert.equal(second.next.apis["POST /v1/auth/session"].consecutiveMisses, 1, "an API not seen on a page that WAS crawled is tracked as missed, never deleted");
  assert.equal(second.next.pages["/register"].firstSeenAt, T0, "first observation time is preserved");
  assert.equal(second.next.pages["/register"].lastSeenAt, T1);
});

test("existing page/forms merge keeps B2 observations instead of dropping them", () => {
  const withKnowledge = computeCrawlKnowledgeUpdate(empty(), { scans: [register], apiCalls: [], observedAt: T0 }).next;
  const { next } = computeApplicationModelUpdate(withKnowledge, { "/register": [{ selector: "form", fields: [{ name: "email" }] }] }, T1);
  assert.equal(next.pages["/register"].access?.state, "login_page");
  assert.deepEqual(next.pages["/register"].observed?.fields, ["Email", "Password"]);
});

test("normalize preserves stories/declared only when present (frozen v2 shape unchanged otherwise)", () => {
  assert.equal("stories" in normalizeApplicationModel(null), false);
  const withStory = upsertStory(empty(), buildStoryRecord("As a user\nI want x", empty(), T0));
  assert.equal(Object.keys(normalizeApplicationModel(withStory).stories ?? {}).length, 1);
});

const STORY = `As a new Bes user
I want to create an account with my email and password
So that my journal and safety plan are saved

Acceptance criteria:
- The registration page shows Email and Password fields
- The Create Account option is reachable from the landing page
- I receive a welcome SMS after registering`;

test("user stories parse into role/goal/benefit and acceptance criteria (bullets and Gherkin)", () => {
  const s = parseUserStory(STORY);
  assert.equal(s.role, "new Bes user");
  assert.equal(s.goal, "create an account with my email and password");
  assert.equal(s.benefit, "my journal and safety plan are saved");
  assert.equal(s.criteria.length, 3);
  const g = parseUserStory("Given I am on the login page\nWhen I submit an empty form\nThen I see an error");
  assert.equal(g.criteria.length, 3);
});

test("criteria map only to OBSERVED elements; no evidence stays unverifiable, and nothing is marked verified", () => {
  const store = computeCrawlKnowledgeUpdate(empty(), { scans: [landing, register], apiCalls: [], observedAt: T0 }).next;
  const story = buildStoryRecord(STORY, store, T1, "run-9");
  const [fields, create, sms] = story.criteria;
  assert.equal(fields.status, "elements_observed");
  assert.equal(fields.evidence[0].routeHint, "/register");
  assert.deepEqual(fields.evidence[0].matched.sort(), ["Email", "Password"]);
  assert.equal(create.status, "elements_observed");
  assert.equal(create.evidence[0].routeHint, "/");
  assert.equal(sms.status, "no_evidence", "an SMS that was never observed is not invented");
  assert.ok(story.criteria.every((c) => (c.status as string) !== "verified"));
  assert.deepEqual(mapCriterionToEvidence("The page should show content", store.pages), [], "stop-words alone never count as evidence");
  // Evidence is refreshed (not invented) when pages change.
  const refreshed = refreshStoryEvidence(upsertStory(empty(), story), T1);
  assert.equal(Object.values(refreshed.stories!)[0].criteria[0].status, "no_evidence", "with no observed pages, prior evidence does not persist as fact");
});

function inputs(over: Partial<KnowledgeInputs> = {}): KnowledgeInputs {
  let store = computeCrawlKnowledgeUpdate(empty(), {
    scans: [landing, register, profile, { url: "https://app.test/resources", status: 200, headings: ["Resources"], buttons: ["Call hotline"] }],
    apiCalls: [
      { method: "GET", origin: "https://api.app.test", path: "/v1/resources/1", status: 200, route: "/resources" },
      { method: "GET", origin: "https://api.app.test", path: "/v1/health", status: 503, route: "/" },
    ],
    observedAt: T0,
  }).next;
  store = upsertStory(store, buildStoryRecord(STORY, store, T1));
  store.pages["/old"] = { routeHint: "/old", forms: [], signature: "x", firstSeenAt: T0, lastSeenAt: T0, lastChangedAt: T0, consecutiveMisses: 2 };
  return {
    store,
    coverage: [
      { routeHint: "/", testCaseId: "tc-home", lastResultStatus: "passed", lastRunAt: T1 },
      { routeHint: "/register", testCaseId: "tc-reg", lastResultStatus: "failed", lastRunAt: T1 },
      { routeHint: "/old", testCaseId: "tc-old", lastResultStatus: "passed", lastRunAt: T0 },
    ],
    qaFailures: [{ testCaseId: "tc-reg", routeHint: "/register", lastResultStatus: "failed", lastFailureMessage: "element(s) not found", lastRunAt: T1 }],
    apiTestPaths: ["/v1/resources/{id}"],
    testTitles: [{ id: "tc-reg", title: "Form submits - /register" }],
    ...over,
  };
}

test("next-test decisions use only known facts: no repeats, no invention, blocked items are never tests", () => {
  const recs = recommendNextTests(inputs());
  const by = (kind: string) => recs.filter((r) => r.kind === kind);
  assert.deepEqual(by("investigate_failure").map((r) => r.target), ["/register"]);
  assert.match(by("investigate_failure")[0].reason, /Form submits - \/register/);
  assert.deepEqual(by("cover_page").map((r) => r.target), ["/resources"], "/ and /register are already covered - not repeated");
  assert.deepEqual(by("needs_credentials").map((r) => r.target), ["/profile"]);
  assert.ok(by("needs_credentials").every((r) => !r.actionable && r.priority === 9));
  assert.deepEqual(by("cover_api").map((r) => r.target), ["GET /v1/health"], "the resources API already has an API test");
  assert.equal(by("cover_api")[0].priority, 2, "observed server errors raise priority");
  assert.deepEqual(by("verify_missing_page").map((r) => r.target), ["/old"]);
  assert.equal(by("cover_story_criterion").length, 2);
  assert.equal(by("unverifiable_criterion").length, 1);
  assert.ok(by("unverifiable_criterion").every((r) => !r.actionable));
  assert.ok(recs.every((r) => r.evidence.every((e) => e.source !== "inference")));
  const prios = recs.map((r) => r.priority);
  assert.deepEqual(prios, [...prios].sort((a, b) => a - b), "ranked by priority");
});

test("incremental discovery seeds missing/uncovered/stale known pages first, bounded, never auth-gated ones", () => {
  const k = inputs();
  const seeds = incrementalSeedRoutes(k.store, new Set(k.coverage.map((c) => c.routeHint)), "2026-12-30T00:00:00.000Z", 3);
  assert.equal(seeds.length, 3);
  assert.equal(seeds[0], "/old", "previously-seen-but-missing pages are revisited first");
  assert.ok(!seeds.includes("/profile"));
  assert.deepEqual(incrementalSeedRoutes(k.store, new Set(), T1, 0), []);
});

test("repository inspection extracts declared UI/API routes and test files, bounded and read-only", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tm-repo-inspect-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dir, "src", "routes"), { recursive: true });
  await fs.mkdir(path.join(dir, "node_modules", "x"), { recursive: true });
  await fs.writeFile(path.join(dir, "src", "routes", "AppRoutes.tsx"), `<Route path="/journal" element={<J/>} /><Route path="*" element={<N/>} />`);
  await fs.writeFile(path.join(dir, "src", "server.ts"), `app.get("/api/notes", h); fastify.post<{Body: X}>('/api/notes/:id', h);`);
  await fs.writeFile(path.join(dir, "src", "notes.spec.ts"), `test('x', () => {})`);
  await fs.writeFile(path.join(dir, "node_modules", "x", "index.js"), `app.get("/ignored", h)`);
  const declared = await inspectRepository(dir, "fixture");
  assert.deepEqual(declared.uiRoutes.map((r) => r.path), ["/journal"]);
  assert.deepEqual(declared.apiRoutes.map((r) => `${r.method} ${r.path}`).sort(), ["GET /api/notes", "POST /api/notes/:id"]);
  assert.deepEqual(declared.testFiles, ["src/notes.spec.ts"]);
  assert.equal(declared.source, "repository");
  assert.equal(declared.truncated, false);
  assert.deepEqual(extractDeclaredRoutes([{ file: "a.ts", content: "" }]), { uiRoutes: [], apiRoutes: [] });
});

test("observed labels come from what users see: selectors reduce to visible text, unlabeled fields use their observed type", async () => {
  const { visibleTextOf, fieldLabelOf, observePage, attributeRoute } = await import("./app-knowledge.js");
  assert.equal(visibleTextOf('button:has-text("Sign In")'), "Sign In");
  assert.equal(visibleTextOf('[tabindex="0"]:has-text("Safety Plan")'), "Safety Plan");
  assert.equal(visibleTextOf('button:has-text("Already have an account? Sign in->")'), "Already have an account? Sign in");
  assert.equal(visibleTextOf('[data-testid="landing-sign-in-btn"]'), "", "attribute-only selectors carry no user-visible label");
  assert.equal(visibleTextOf("Continue"), "Continue");
  assert.equal(fieldLabelOf({ name: "auth-email-input", type: "email" }), "email");
  assert.equal(fieldLabelOf({ name: "auth-password-input", type: "password" }), "password");
  assert.equal(fieldLabelOf({ name: "firstName", type: "text" }), "first name");
  assert.equal(fieldLabelOf({ name: "x", placeholder: "Your name" }), "Your name");

  // Real Bes /register scan shape (from the live crawl).
  const obs = observePage({
    url: "https://www.bes-app.com/register", status: 200,
    buttons: ['button:has-text("Sign In")', 'button:has-text("Create Account")', '[data-testid="auth-submit-btn"]', 'button:has-text("Continue to Contact")'],
    controls: [{ label: "Sign In" }],
    fields: [{ name: "your-name", placeholder: "Your name" }, { name: "auth-email-input", type: "email" }, { name: "auth-password-input", type: "password" }],
  }, T0);
  assert.deepEqual(obs.actions, ["Sign In", "Create Account", "Continue to Contact"], "deduplicated, selector noise removed");
  assert.deepEqual(obs.fields, ["Your name", "email", "password"]);

  assert.equal(attributeRoute("Form submits – /register", ["/", "/register", "/forgot-password"]), "/register");
  assert.equal(attributeRoute("Form submits – /forgot-password", ["/", "/register", "/forgot"]), null, "a partial route is never matched");
  assert.equal(attributeRoute("Navigate /profile → /emergency", ["/", "/register"]), null, "routes the Brain never observed are not attributed");
});

test("slug-valued labels never stand in for human text", async () => {
  const { fieldLabelOf } = await import("./app-knowledge.js");
  assert.equal(fieldLabelOf({ label: "auth-email-input", type: "email" }), "email", "real Bes /register field shape");
  assert.equal(fieldLabelOf({ label: "auth-password-input", type: "password" }), "password");
  assert.equal(fieldLabelOf({ label: "journal_entry_text", type: "text" }), "journal entry text");
  assert.equal(fieldLabelOf({ label: "Email address", type: "email" }), "Email address");
});

test("route claims are read from existing test titles (used only to decide what to observe next)", async () => {
  const { routeClaimsFromTitles, fieldLabelOf } = await import("./app-knowledge.js");
  assert.deepEqual(routeClaimsFromTitles(["Page loads: /forgot-password", "Navigate /profile → /emergency", "Form submits – /register", "Page loads: /", "notes.spec.ts#x"]),
    ["/emergency", "/forgot-password", "/profile", "/register"]);
  assert.equal(fieldLabelOf({ name: "auth-email-input", type: "email", placeholder: "you@example.com" }), "email", "observed type beats sample-text placeholders");
  assert.equal(fieldLabelOf({ name: "your-name", type: "text", placeholder: "Your name" }), "Your name");
});

test("routes the app redirects away (real Bes behavior) are recorded as observed access, not as content or tests", () => {
  const { next, diff } = computeCrawlKnowledgeUpdate(empty(), {
    scans: [landing],
    apiCalls: [],
    redirects: [
      { url: "https://app.test/profile", finalUrl: "https://app.test/", status: 200 },
      { url: "https://app.test/settings", finalUrl: "https://app.test/login", status: 200 },
    ],
    observedAt: T0,
  });
  assert.equal(next.pages["/profile"].access?.state, "redirected");
  assert.equal(next.pages["/profile"].access?.evidence, "requested /profile, landed on /");
  assert.equal(next.pages["/profile"].observed, undefined, "the landing page's elements are never attributed to /profile");
  assert.equal(next.pages["/settings"].access?.state, "auth_required", "a redirect to a login route is auth evidence");
  assert.deepEqual(diff.redirected, ["/profile"]);
  const recs = recommendNextTests({ store: next, coverage: [{ routeHint: "/profile", testCaseId: "t", lastResultStatus: "failed", lastRunAt: T0 }], qaFailures: [], apiTestPaths: [] });
  const r = recs.find((x) => x.target === "/profile")!;
  assert.equal(r.kind, "inaccessible_page");
  assert.equal(r.actionable, false);
  assert.match(r.reason, /reason .* is not assumed/);
});
