// B3: Intelligent autonomous test planning - pure logic, no Prisma/browser imports.
//
// Builds a risk-prioritized, evidence-mapped test plan from what the Application Brain knows
// (B2: observed pages/forms/fields/access, captured APIs, user stories, declared routes,
// authored workflows), existing coverage, failure history, and the existing planner's cases.
//
// Invariants:
//   - Every scenario cites evidence (an observation, an acceptance criterion, or history).
//     No evidence -> no executable scenario (it is reported as blocked/unverifiable instead).
//   - Auth-gated/redirected routes yield only (a) an access-control check of the OBSERVED
//     behavior and (b) a blocked placeholder - never guessed functionality.
//   - Anything with real-world side effects is classified and must be explicitly approved
//     before it is executed.
//   - The plan is persisted; generation, execution and repair reference scenario objectives.
import { createHash } from "node:crypto";
import type { ApplicationModelPage, ApplicationModelStore } from "./application-model.js";
import { pathMatches } from "./app-knowledge.js";

export type ScenarioCategory = "positive" | "negative" | "boundary" | "integration" | "security" | "workflow";
export type ScenarioStatus = "ready" | "blocked_auth" | "blocked_unverifiable";
export type RiskLevel = "safe" | "sensitive" | "destructive";
export type EvidenceSource = "crawl" | "user_story" | "api" | "repository" | "test_run" | "workflow" | "planner";

export type ScenarioKind =
  | "existing_case" | "reverify" | "access_denied" | "auth_access" | "required_empty" | "invalid_email"
  | "pattern" | "password_masked" | "https_only" | "xss_reflection" | "navigate" | "criterion" | "api_ok";

export type PlanScenario = {
  id: string;
  /** Which objective template this scenario is (drives B4 code generation). */
  kind: ScenarioKind;
  requiresAuth?: boolean;
  title: string;
  category: ScenarioCategory;
  route: string;
  /** What must be true for this test to pass - the objective generation/repair must preserve. */
  objective: string;
  evidence: Array<{ source: EvidenceSource; detail: string; observedAt?: string | null }>;
  criteria: Array<{ storyKey: string; criterionId: string; text: string }>;
  coverage: "existing" | "missing";
  existingTests: string[];
  status: ScenarioStatus;
  blockedReason?: string;
  risk: { level: RiskLevel; reasons: string[] };
  priority: { score: number; tier: "P1" | "P2" | "P3"; breakdown: Record<string, number> };
  /** Second route a workflow scenario ends on. */
  target?: string;
  /** generated_now: an existing generator case will run it; to_generate: B4 must write it; not_executable: blocked. */
  execution: { mode: "generated_now" | "to_generate" | "not_executable"; testTitle?: string };
};

export type QePlan = {
  version: 1;
  createdAt: string;
  jobId: string;
  projectId: string;
  baseUrl: string;
  scenarios: PlanScenario[];
  summary: {
    total: number;
    byCategory: Record<ScenarioCategory, number>;
    byStatus: Record<ScenarioStatus, number>;
    coverage: { existing: number; missing: number };
    risk: Record<RiskLevel, number>;
    tiers: Record<"P1" | "P2" | "P3", number>;
    /** Executable-now scenarios that require explicit approval before they run. */
    needsApproval: number;
  };
};

export type PlanInputs = {
  jobId: string;
  projectId: string;
  baseUrl: string;
  store: ApplicationModelStore;
  coverageRoutes: string[];
  failing: Array<{ route: string; title: string; lastFailureMessage: string | null; lastRunAt: string | null }>;
  existingTests: Array<{ title: string }>;
  apiTestPaths: string[];
  /** The existing deterministic planner's cases (these are what the generator writes today). */
  generatorCases: Array<{ title: string; page: string }>;
  now: string;
};

// ── Side-effect (destructive) detection ─────────────────────────────────────

const DESTRUCTIVE = /\b(delete|remove|destroy|erase|wipe|deactivate|close (my )?account|data deletion|cancel (my )?(subscription|account)|unsubscribe|reset (all )?data|drop|purge)\b/i;
const REAL_WORLD = /\b(emergency|sos|alert (trusted )?contacts?|share (my )?location|call (911|hotline|police)|panic|pay|payment|purchase|checkout|place order|order now|donate|transfer|send money)\b/i;
const LEGAL_LINK = /\b(terms|privacy|policy|cookies?|legal|data deletion|gdpr|accessibility statement|faq|about)\b/i;
const CREATES_OR_NOTIFIES =/\b(register|sign ?up|create (an |your )?account|send (reset )?code|reset password|forgot password|send|submit report|message|sms|invite|subscribe|post|publish|upload|book|reserve|contact us)\b/i;

/** Classifies what a test would DO to the target, from the route and observed labels of the page it acts on. */
export function classifyRisk(input: { route: string; acts: boolean; labels: string[]; category: ScenarioCategory; active?: boolean }): { level: RiskLevel; reasons: string[] } {
  const reasons: string[] = [];
  if (input.active) reasons.push("active security probe (injects payloads into live inputs)");
  if (!input.acts) return { level: input.active ? "sensitive" : "safe", reasons };
  const routeText = input.route.replace(/[/-]/g, " ");
  // Legal/informational links ("Data Deletion", "Privacy Policy") describe policies, not what
  // the test does. A route with an unambiguous sign-in intent is judged by its route alone -
  // a "Create Account" toggle on /login doesn't make logging in create an account.
  const labels = /\b(login|log in|sign ?in|signin)\b/i.test(routeText)
    ? []
    : input.labels.filter((l) => !LEGAL_LINK.test(l));
  const text = [routeText, ...labels].join(" | ");
  const d = DESTRUCTIVE.exec(text);
  if (d) reasons.push(`may delete or irreversibly change data ("${d[0]}")`);
  const r = REAL_WORLD.exec(text);
  if (r) reasons.push(`may trigger a real-world action ("${r[0]}")`);
  const c = CREATES_OR_NOTIFIES.exec(text);
  if (c && input.category !== "negative") reasons.push(`may create records or send notifications ("${c[0]}")`);
  if (d || r) return { level: "destructive", reasons };
  if (reasons.length) return { level: "sensitive", reasons };
  return { level: "safe", reasons };
}

// ── Prioritization ───────────────────────────────────────────────────────────

const CATEGORY_WEIGHT: Record<ScenarioCategory, number> = { security: 20, workflow: 18, negative: 14, boundary: 12, integration: 12, positive: 10 };
const CRITICAL = /\b(auth|login|sign ?in|register|sign ?up|password|account|payment|checkout|emergency|safety|security|delete|profile|contacts?)\b/i;

export function scoreScenario(s: Pick<PlanScenario, "category" | "route" | "title" | "criteria" | "coverage">, ctx: { failingRoutes: Set<string>; workflowRiskTags: Map<string, string[]>; serverErrors: boolean }) {
  const breakdown: Record<string, number> = { category: CATEGORY_WEIGHT[s.category] };
  if (CRITICAL.test(`${s.route.replace(/[/-]/g, " ")} ${s.title}`)) breakdown.businessCritical = 25;
  if (s.criteria.length) breakdown.acceptanceCriterion = 20;
  if (ctx.failingRoutes.has(s.route)) breakdown.previouslyFailing = 30;
  if (s.coverage === "missing") breakdown.missingCoverage = 15;
  const tags = ctx.workflowRiskTags.get(s.route) ?? [];
  if (tags.length) breakdown.workflowRisk = Math.min(20, tags.length * 10);
  if (ctx.serverErrors) breakdown.serverErrorsObserved = 15;
  const score = Object.values(breakdown).reduce((a, b) => a + b, 0);
  return { score, tier: (score >= 60 ? "P1" : score >= 35 ? "P2" : "P3") as "P1" | "P2" | "P3", breakdown };
}

// ── Plan construction ────────────────────────────────────────────────────────

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9/]+/g, " ").replace(/\s+/g, " ").trim();
const sid = (...parts: string[]) => createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 12);

function findExisting(existing: Array<{ title: string }>, route: string, keywords: string[]): string[] {
  const r = norm(route);
  return existing
    .filter((t) => { const n = ` ${norm(t.title)} `; return (route === "/" ? true : n.includes(` ${r} `) || n.includes(` ${r}`)) && keywords.every((k) => n.includes(k)); })
    .map((t) => t.title)
    .slice(0, 5);
}

const pageLabels = (p?: ApplicationModelPage) => [...(p?.observed?.actions ?? []), ...(p?.observed?.fields ?? []), ...(p?.observed?.headings ?? []), ...(p?.observed?.title ? [p.observed.title] : [])];
const crawlEvidence = (p: ApplicationModelPage, detail: string) => ({ source: "crawl" as const, detail, observedAt: p.observed?.observedAt ?? p.access?.observedAt ?? p.lastSeenAt });

function categoryOfGeneratorCase(title: string): ScenarioCategory {
  if (/navigate|→|->/.test(title)) return "workflow";
  if (/invalid|error|reject|empty/i.test(title)) return "negative";
  return "positive";
}

function categoryOfCriterion(text: string): ScenarioCategory {
  if (/\b(invalid|error|reject|wrong|empty|fail|cannot|can't|denied|not allowed)\b/i.test(text)) return "negative";
  if (/\b(from the|navigate|reachable|redirect|then|after)\b/i.test(text)) return "workflow";
  if (/\b(secure|encrypt|mask|permission|authori[sz]|https)\b/i.test(text)) return "security";
  return "positive";
}

export function buildQePlan(input: PlanInputs): QePlan {
  const { store } = input;
  const pages = store.pages;
  const failingRoutes = new Set(input.failing.map((f) => f.route));
  const workflowRiskTags = new Map<string, string[]>();
  for (const wf of Object.values(store.workflows ?? {})) for (const r of wf.routeHints) workflowRiskTags.set(r, [...(workflowRiskTags.get(r) ?? []), ...wf.riskTags]);
  const coverageRoutes = new Set(input.coverageRoutes);
  const scenarios: PlanScenario[] = [];
  const seen = new Set<string>();

  const add = (s: Omit<PlanScenario, "id" | "priority" | "risk"> & { risk?: PlanScenario["risk"]; acts?: boolean; active?: boolean; serverErrors?: boolean }) => {
    const id = sid(s.category, s.route, s.title);
    if (seen.has(id)) return;
    seen.add(id);
    const risk = s.risk ?? classifyRisk({ route: s.route, acts: s.acts ?? false, labels: pageLabels(pages[s.route]), category: s.category, active: s.active });
    const { acts: _a, active: _b, serverErrors, ...rest } = s;
    scenarios.push({ ...rest, id, risk, priority: scoreScenario(rest, { failingRoutes, workflowRiskTags, serverErrors: !!serverErrors }) });
  };

  // 1) The existing planner's cases: executable now; mapped to the page they act on.
  for (const c of input.generatorCases) {
    const route = c.page || "/";
    const p = pages[route];
    const category = categoryOfGeneratorCase(c.title);
    const acts = /submit|send|create|delete|save/i.test(c.title);
    const existing = input.existingTests.filter((t) => norm(t.title) === norm(c.title)).map((t) => t.title);
    add({
      kind: "existing_case", title: c.title, category, route,
      objective: /page loads/i.test(c.title) ? `${route} renders successfully for a signed-out visitor` : c.title,
      evidence: p ? [crawlEvidence(p, `page observed (${p.access?.state ?? "forms"})`)] : [{ source: "planner", detail: "case derived from the existing planner's scan of this page" }],
      criteria: [], coverage: existing.length ? "existing" : "missing", existingTests: existing,
      status: "ready", execution: { mode: "generated_now", testTitle: c.title }, acts,
    });
  }

  for (const p of Object.values(pages)) {
    if (p.consecutiveMisses > 0) continue;
    const route = p.routeHint;
    const access = p.access?.state;

    // 2) Access control: what WAS observed for signed-out visitors is itself a security regression check.
    if (access === "redirected" || access === "auth_required") {
      const final = p.access!.finalRoute ?? "a sign-in page";
      add({
        kind: "access_denied", title: `Anonymous access to ${route} is denied (lands on ${final})`, category: "security", route,
        objective: `A signed-out visitor requesting ${route} must not reach its content; observed behavior: ${p.access!.evidence}`,
        evidence: [{ source: "crawl", detail: p.access!.evidence, observedAt: p.access!.observedAt }], criteria: [],
        coverage: findExisting(input.existingTests, route, ["anonymous"]).length ? "existing" : "missing", existingTests: findExisting(input.existingTests, route, ["anonymous"]),
        status: "ready", execution: { mode: "to_generate" },
      });
      if (!store.authenticatedPages?.[route] || store.authenticatedPages[route].access?.state !== "public") {
        add({
          kind: "auth_access", title: `Exercise ${route} as a signed-in user`, category: "positive", route,
          objective: `Unknown until observed with approved test credentials - functionality behind ${route} is not assumed`,
          evidence: [
            ...(coverageRoutes.has(route) ? [{ source: "test_run" as const, detail: "existing tests target this route" }] : []),
            ...(store.declared?.uiRoutes.some((r) => r.path === route) ? [{ source: "repository" as const, detail: "route declared in source" }] : []),
          ],
          criteria: [], coverage: coverageRoutes.has(route) ? "existing" : "missing", existingTests: [],
          status: "blocked_auth", blockedReason: `Requires authentication (${p.access!.evidence}); provide approved test credentials to observe and plan this area`,
          execution: { mode: "not_executable" },
        });
      }
      continue;
    }
    if (access === "unreachable") continue;

    // 3) Forms on observable pages: negative / boundary / security scenarios from OBSERVED constraints only.
    const fields = p.forms.flatMap((f) => f.fields);
    const observedFields = p.observed?.fields ?? [];
    const required = fields.filter((f) => f.required);
    if (required.length) {
      add({
        kind: "required_empty", title: `Submitting ${route} with required fields empty is rejected`, category: "negative", route,
        objective: `Submitting without ${required.map((f) => f.label || f.name).join(", ")} does not succeed and indicates what is missing`,
        evidence: [crawlEvidence(p, `required fields observed: ${required.map((f) => f.label || f.name).join(", ")}`)], criteria: [],
        coverage: findExisting(input.existingTests, route, ["empty"]).length ? "existing" : "missing", existingTests: findExisting(input.existingTests, route, ["empty"]),
        status: "ready", execution: { mode: "to_generate" }, acts: true,
      });
    }
    const emailField = fields.find((f) => f.type === "email") ?? (observedFields.includes("email") ? { name: "email", type: "email" } : null);
    if (emailField) {
      add({
        kind: "invalid_email", title: `An invalid email on ${route} is rejected`, category: "negative", route,
        objective: `Entering a malformed email address on ${route} does not submit successfully`,
        evidence: [crawlEvidence(p, "email-type input observed")], criteria: [],
        coverage: findExisting(input.existingTests, route, ["invalid", "email"]).length ? "existing" : "missing", existingTests: findExisting(input.existingTests, route, ["invalid", "email"]),
        status: "ready", execution: { mode: "to_generate" }, acts: true,
      });
    }
    for (const f of fields.filter((x) => x.pattern)) {
      add({
        kind: "pattern", title: `${f.label || f.name} on ${route} rejects values not matching its pattern`, category: "boundary", route,
        objective: `A value violating the observed pattern ${f.pattern} for ${f.label || f.name} is not accepted`,
        evidence: [crawlEvidence(p, `pattern constraint observed: ${f.pattern}`)], criteria: [],
        coverage: "missing", existingTests: [], status: "ready", execution: { mode: "to_generate" }, acts: true,
      });
    }
    const hasPassword = fields.some((f) => f.type === "password") || observedFields.includes("password");
    if (hasPassword) {
      add({
        kind: "password_masked", title: `Password input on ${route} is masked`, category: "security", route,
        objective: `The password field on ${route} is a masked (type=password) input`,
        evidence: [crawlEvidence(p, "password-type input observed")], criteria: [],
        coverage: findExisting(input.existingTests, route, ["password", "mask"]).length ? "existing" : "missing", existingTests: findExisting(input.existingTests, route, ["password", "mask"]),
        status: "ready", execution: { mode: "to_generate" },
      });
      if (/^https:/i.test(input.baseUrl)) {
        add({
          kind: "https_only", title: `Credentials on ${route} are only sent over HTTPS`, category: "security", route,
          objective: `${route} is served over HTTPS so credentials are never submitted in clear text`,
          evidence: [crawlEvidence(p, `page served from ${new URL(input.baseUrl).origin}`)], criteria: [],
          coverage: "missing", existingTests: [], status: "ready", execution: { mode: "to_generate" },
        });
      }
    }
    if (observedFields.some((f) => !/password/i.test(f)) && (access === "public" || access === "login_page")) {
      add({
        kind: "xss_reflection", title: `Script/markup input on ${route} is not reflected unescaped`, category: "security", route,
        objective: `Entering an HTML/script payload into ${route}'s inputs never executes or renders it as markup`,
        evidence: [crawlEvidence(p, `text inputs observed: ${observedFields.slice(0, 4).join(", ")}`)], criteria: [],
        coverage: "missing", existingTests: [], status: "ready", execution: { mode: "to_generate" }, acts: true, active: true,
      });
    }

    // 4) Observed navigation adjacency -> multi-page workflows.
    for (const to of p.linksTo ?? []) {
      if (!pages[to] || pages[to].access?.state !== "public" && pages[to].access?.state !== "login_page") continue;
      add({
        kind: "navigate", title: `Navigate ${route} → ${to}`, category: "workflow", route,
        objective: `A visitor on ${route} can reach ${to} through the page's own navigation`,
        evidence: [crawlEvidence(p, `link from ${route} to ${to} observed`)], criteria: [], target: to,
        coverage: findExisting(input.existingTests, route, [norm(to)]).length ? "existing" : "missing", existingTests: findExisting(input.existingTests, route, [norm(to)]),
        status: "ready", execution: { mode: "to_generate" },
      });
    }
  }

  // 5) Acceptance criteria (expected behavior) mapped to observed evidence; unsupported ones are blocked.
  for (const story of Object.values(store.stories ?? {})) {
    for (const c of story.criteria) {
      const route = c.evidence[0]?.routeHint ?? "/";
      const category = categoryOfCriterion(c.text);
      const routes = [...new Set(c.evidence.map((e) => e.routeHint))];
      const crit = [{ storyKey: story.key, criterionId: c.id, text: c.text }];
      if (c.status === "no_evidence") {
        add({
          kind: "criterion", title: `AC: ${c.text}`, category, route: "/", objective: c.text, evidence: [{ source: "user_story", detail: `${story.title} / ${c.id}` }], criteria: crit,
          coverage: "missing", existingTests: [], status: "blocked_unverifiable",
          blockedReason: "No element referenced by this criterion was observed on any discovered page - not planned until the functionality is found, made accessible, or clarified",
          execution: { mode: "not_executable" },
        });
        continue;
      }
      add({
        kind: "criterion", title: `AC: ${c.text}`, category, route,
        objective: c.text,
        evidence: [{ source: "user_story", detail: `${story.title} / ${c.id}` }, ...c.evidence.map((e) => ({ source: "crawl" as const, detail: `${e.routeHint}: ${e.matched.join(", ")}`, observedAt: e.observedAt }))],
        criteria: crit, requiresAuth: c.evidence.some((e) => !!store.authenticatedPages?.[e.routeHint] && !["public", "login_page"].includes(pages[e.routeHint]?.access?.state ?? "")), coverage: "missing", existingTests: [], status: "ready",
        execution: { mode: "to_generate" }, acts: category !== "positive" || routes.length > 1,
      });
    }
  }

  // 6) Captured APIs -> integration scenarios (first-party, observed only).
  for (const [key, api] of Object.entries(store.apis)) {
    if (api.source !== "crawl" || api.consecutiveMisses > 0) continue;
    const covered = input.apiTestPaths.some((t) => pathMatches(api.path, t));
    const route = api.observedOnRoutes?.[0] ?? "/";
    const ok = (api.statuses ?? []).filter((s) => s < 400);
    add({
      kind: "api_ok", title: `${key} responds successfully when ${route} loads`, category: "integration", route,
      objective: `${key}, called by the app on ${route}, returns ${ok.length ? ok.join("/") : "a non-error status"}${(api.statuses ?? []).some((s) => s >= 500) ? " (server errors were observed)" : ""}`,
      evidence: [{ source: "api", detail: `${api.origin ?? ""}${api.path} observed with status ${(api.statuses ?? []).join("/")}`, observedAt: api.lastSeenAt }], criteria: [],
      coverage: covered ? "existing" : "missing", existingTests: covered ? input.apiTestPaths.filter((t) => pathMatches(api.path, t)).slice(0, 3) : [],
      status: "ready", execution: { mode: "to_generate" }, acts: !/^GET /.test(key), serverErrors: (api.statuses ?? []).some((s) => s >= 500),
    });
  }

  // 7) Previously failing tests: re-verify first (existing coverage, highest urgency).
  for (const f of input.failing) {
    add({
      kind: "reverify", title: `Re-verify failing test: ${f.title}`, category: categoryOfGeneratorCase(f.title), route: f.route,
      objective: `Determine whether "${f.title}" fails because of a product defect or a test defect - the test's original assertion must not be weakened`,
      evidence: [{ source: "test_run", detail: (f.lastFailureMessage ?? "failed").slice(0, 240), observedAt: f.lastRunAt }], criteria: [],
      coverage: "existing", existingTests: [f.title], status: "ready", execution: { mode: "generated_now", testTitle: f.title },
      acts: /submit|send|create|delete/i.test(f.title),
    });
  }

  for (const route of store.declared?.uiRoutes ?? []) {
    if (pages[route.path] && pages[route.path].consecutiveMisses === 0) continue;
    add({ kind: "auth_access", title: `Verify declared route ${route.path}`, category: "positive", route: route.path, objective: `Observe and verify the behavior declared for ${route.path}`, evidence: [{ source: "repository", detail: `${route.file}: ${route.path}` }], criteria: [], coverage: "missing", existingTests: [], status: "blocked_unverifiable", blockedReason: "Declared in source but not observed within the discovery scope or resource limit", execution: { mode: "not_executable" } });
  }
  const protectedPages = Object.fromEntries(Object.entries(store.authenticatedPages ?? {}).filter(([r, p]) => p.access?.state === "public" && !["public", "login_page"].includes(pages[r]?.access?.state ?? "")));
  if (Object.keys(protectedPages).length) {
    const authenticated = buildQePlan({ ...input, store: { ...store, pages: protectedPages, authenticatedPages: {}, declared: undefined, apis: {}, stories: {} }, generatorCases: [], failing: [] });
    for (const s of authenticated.scenarios) scenarios.push({ ...s, id: sid(s.category, s.route, s.title + " (authenticated)"), requiresAuth: true, title: s.title + " (authenticated)" });
    for (const [route, p] of Object.entries(protectedPages)) {
      add({ kind: "auth_access", title: `Observed content of ${route} is available after sign-in`, category: "positive", route, requiresAuth: true,
        objective: `A signed-in user reaches ${route} and sees the content observed during authenticated discovery`, evidence: [crawlEvidence(p, "authenticated page content observed")], criteria: [], coverage: "missing", existingTests: [], status: "ready", execution: { mode: "to_generate" } });
    }
  }
  scenarios.sort((a, b) => (a.status === "ready" ? 0 : 1) - (b.status === "ready" ? 0 : 1) || b.priority.score - a.priority.score || a.title.localeCompare(b.title));
  const count = <K extends string>(keys: K[], pick: (s: PlanScenario) => K) => Object.fromEntries(keys.map((k) => [k, scenarios.filter((s) => pick(s) === k).length])) as Record<K, number>;
  return {
    version: 1, createdAt: input.now, jobId: input.jobId, projectId: input.projectId, baseUrl: input.baseUrl, scenarios,
    summary: {
      total: scenarios.length,
      byCategory: count(["positive", "negative", "boundary", "integration", "security", "workflow"], (s) => s.category),
      byStatus: count(["ready", "blocked_auth", "blocked_unverifiable"], (s) => s.status),
      coverage: { existing: scenarios.filter((s) => s.coverage === "existing").length, missing: scenarios.filter((s) => s.coverage === "missing").length },
      risk: count(["safe", "sensitive", "destructive"], (s) => s.risk.level),
      tiers: count(["P1", "P2", "P3"], (s) => s.priority.tier),
      needsApproval: scenarios.filter((s) => s.execution.mode === "generated_now" && s.status === "ready" && s.risk.level !== "safe").length,
    },
  };
}

/** Executable-now tests that must not run without explicit approval, by Playwright test title. */
export function gatedTestTitles(plan: QePlan): Array<{ title: string; level: RiskLevel; reasons: string[] }> {
  const out = new Map<string, { title: string; level: RiskLevel; reasons: string[] }>();
  for (const s of plan.scenarios) {
    if (s.execution.mode !== "generated_now" || s.status !== "ready" || s.risk.level === "safe" || !s.execution.testTitle) continue;
    const prev = out.get(s.execution.testTitle);
    if (!prev || (prev.level === "sensitive" && s.risk.level === "destructive")) out.set(s.execution.testTitle, { title: s.execution.testTitle, level: s.risk.level, reasons: s.risk.reasons });
  }
  return [...out.values()];
}

/** Playwright --grep-invert pattern that excludes exactly these test titles. */
export function grepInvertFor(titles: string[]): string | undefined {
  if (!titles.length) return undefined;
  return titles.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
}

/** The original objective for a test title, so generation and repair can preserve it. */
export function objectiveForTest(plan: QePlan, testTitle: string): PlanScenario | null {
  return plan.scenarios.find((s) => s.execution.testTitle === testTitle) ?? null;
}

/** Test titles declared in generated spec source (`test('title', ...)`), for gating the whole suite under test. */
export function testTitlesInSpec(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(/\b(?:test|qe)(?:\.only)?\(\s*(["'`])((?:\\.|(?!\1).)*)\1/g)) out.push(m[2].replace(/\\(["'`\\])/g, "$1"));
  return out;
}

/**
 * Classifies every test in the suite under test - including ones generated by earlier runs that
 * this plan didn't produce - so nothing with side effects runs without approval. A title's route
 * is taken from the route it names (e.g. "Form submits – /register").
 */
export function gateSuiteTests(plan: QePlan, suiteTitles: string[], store: ApplicationModelStore): Array<{ title: string; level: RiskLevel; reasons: string[] }> {
  const gated = new Map(gatedTestTitles(plan).map((g) => [g.title, g]));
  for (const title of suiteTitles) {
    if (gated.has(title)) continue;
    if (plan.scenarios.some((s) => s.execution.testTitle === title && s.risk.level === "safe")) continue;
    const route = (/(?:^|[\s:(\u2013\u2014\u2192>-])(\/[a-z0-9][a-z0-9\-_/]*)/i.exec(title)?.[1]) ?? "/";
    const acts = /submit|send|create|delete|save|register|sign ?up|checkout|pay/i.test(title);
    const risk = classifyRisk({ route, acts, labels: pageLabels(store.pages[route]), category: categoryOfGeneratorCase(title) });
    if (risk.level !== "safe") gated.set(title, { title, level: risk.level, reasons: risk.reasons });
  }
  return [...gated.values()];
}
