// B2: Application knowledge - pure logic, no Prisma/browser imports (same discipline as
// application-model.ts). Turns crawl evidence into persistent, provenance-stamped facts in the
// Application Brain, parses user stories (expected behavior), maps acceptance criteria to
// OBSERVED evidence only, inspects repository sources for declared routes, and decides what
// should be tested next from what is actually known.
//
// Rules this file enforces:
//   - Observed facts carry {source, observedAt, runId}. Nothing inferred is stored as fact.
//   - A criterion with matching elements on a page is "elements_observed" - never "verified";
//     behavior is only verified by an executed, passing test.
//   - Recommendations are built only from observed facts, recorded stories, and execution
//     history. Pages/APIs/criteria with no evidence are reported, never turned into tests.
import { createHash } from "node:crypto";
import {
  computePageSignature,
  normalizeRouteHint,
  type ApplicationModelApi,
  type ApplicationModelPage,
  type ApplicationModelStore,
  type ApplicationModelStory,
  type DeclaredRoutes,
  type PageAccess,
  type PageObservation,
  type StoryCriterion,
} from "./application-model.js";

const sha1 = (v: string) => createHash("sha1").update(v).digest("hex");
const MAX_LABELS = 25;
const AUTH_PATH_RE = /\/(login|signin|sign-in|auth|sso|oauth|account\/login)(\/|$)/i;

// ── Crawl evidence → Brain ───────────────────────────────────────────────────

export type CrawlScan = {
  url: string;
  finalUrl?: string;
  title?: string;
  status: number;
  buttons?: string[];
  headings?: string[];
  fields?: Array<{ name?: string; label?: string; placeholder?: string; type?: string }>;
  forms?: Array<{ fields: Array<{ name?: string; label?: string; placeholder?: string; type?: string }> }>;
  controls?: Array<{ label?: string }>;
};
export type CrawlApiCall = { method: string; origin: string; path: string; status: number; route: string };

const routeOf = (raw: string) => {
  try { return normalizeRouteHint(new URL(raw).pathname || "/"); } catch { return normalizeRouteHint(raw); }
};

/** Replaces id-like path segments so /users/42 and /users/43 are one endpoint. */
export function templateApiPath(path: string): string {
  const seg = path.split("/").map((p) => {
    if (!p) return p;
    if (/^\d+$/.test(p)) return ":id";
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(p)) return ":id";
    if (/^[0-9a-f]{24,}$/i.test(p) || /^[A-Za-z0-9_-]{20,}$/.test(p) && /\d/.test(p)) return ":id";
    return p;
  });
  return seg.join("/") || "/";
}

function hasPasswordField(scan: CrawlScan) {
  const all = [...(scan.fields ?? []), ...(scan.forms ?? []).flatMap((f) => f.fields)];
  return all.some((f) => f.type === "password");
}

export function classifyPageAccess(scan: CrawlScan, observedAt: string, runId?: string): PageAccess {
  const requested = routeOf(scan.url);
  const final = scan.finalUrl ? routeOf(scan.finalUrl) : requested;
  const base = { httpStatus: scan.status, source: "crawl" as const, observedAt, ...(runId ? { runId } : {}) };
  if (scan.status === 401 || scan.status === 403) {
    return { ...base, state: "auth_required", evidence: `HTTP ${scan.status} for ${requested}` };
  }
  if (final !== requested && AUTH_PATH_RE.test(final) && !AUTH_PATH_RE.test(requested)) {
    return { ...base, state: "auth_required", finalRoute: final, evidence: `${requested} redirected to ${final}` };
  }
  if (scan.status >= 400 || scan.status === 0) {
    return { ...base, state: "unreachable", evidence: `HTTP ${scan.status} for ${requested}` };
  }
  if (hasPasswordField(scan)) {
    return { ...base, state: "login_page", ...(final !== requested ? { finalRoute: final } : {}), evidence: "Page presents a password field" };
  }
  return { ...base, state: "public", ...(final !== requested ? { finalRoute: final } : {}), evidence: `HTTP ${scan.status}` };
}

const clean = (v: unknown) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "");
const uniq = (xs: string[]) => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of xs) {
    const k = x.toLowerCase();
    if (!x || x.length > 120 || seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  return out.slice(0, MAX_LABELS);
};

/** Route paths an existing test's title claims to exercise (e.g. "Page loads: /forgot-password"). Claims, not facts. */
export function routeClaimsFromTitles(titles: string[], max = 50): string[] {
  const out = new Set<string>();
  for (const t of titles) for (const m of t.matchAll(/(?:^|[\s:(\u2013\u2014\u2192>-])(\/[a-z0-9][a-z0-9\-_/]*)/gi)) {
    const r = normalizeRouteHint(m[1]);
    if (r.length > 1 && !/\.(spec|test)\b/.test(r)) out.add(r);
    if (out.size >= max) break;
  }
  return [...out].sort();
}

/** Routes named in a test's title/key that the Brain has actually observed (longest match wins). */
export function attributeRoute(text: string, knownRoutes: string[]): string | null {
  const candidates = knownRoutes.filter((r) => r !== "/" && new RegExp(`(^|[\\s"'(–—-])${r.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[\\s"')?#,.;–—])`).test(text));
  return candidates.sort((a, b) => b.length - a.length)[0] ?? null;
}

/**
 * The crawler records buttons as Playwright selectors (e.g. `button:has-text("Sign In")`).
 * Keep only the user-visible text a selector names; pure attribute selectors carry no label.
 */
export function visibleTextOf(selectorOrText: string): string {
  const s = clean(selectorOrText);
  const hasText = /:(?:has-text|text(?:-is)?)\(\s*(["'])((?:\\.|(?!\1).)*)\1\s*\)/.exec(s);
  if (hasText) return clean(hasText[2]).replace(/\s*(->|→|›)\s*$/, "");
  const textEq = /^text=["']?([^"']+)["']?$/.exec(s);
  if (textEq) return clean(textEq[1]);
  if (/[[\]#>:=]|^\.|^[a-z]+\[/.test(s)) return "";
  return s.replace(/\s*(->|→|›)\s*$/, "");
}

const INPUT_TYPES_AS_LABEL = new Set(["email", "password", "tel", "number", "date", "search", "url"]);
/** Readable name for a field with no label/placeholder: its observed input type, else its name attribute de-slugged. */
export function fieldLabelOf(f: { name?: string; label?: string; placeholder?: string; type?: string }): string {
  // A slug ("auth-email-input") in the label slot is an attribute, not human text.
  const human = (v: unknown) => { const c = clean(v); return c && !/^[a-z0-9]+([-_][a-z0-9]+)+$/i.test(c) ? c : ""; };
  // Precedence: a real label, then the observed input type (more meaningful than sample text),
  // then the placeholder, then the name attribute de-slugged.
  const label = human(f.label);
  if (label) return label;
  if (f.type && INPUT_TYPES_AS_LABEL.has(f.type)) return f.type;
  const placeholder = human(f.placeholder);
  if (placeholder) return placeholder;
  if (!f.name) f = { ...f, name: clean(f.label) || clean(f.placeholder) };
  const words = clean(f.name).replace(/([a-z])([A-Z])/g, "$1 $2").split(/[-_\s]+/).map((w) => w.toLowerCase())
    .filter((w) => w && !["auth", "input", "field", "form", "txt", "fld"].includes(w));
  return words.join(" ");
}

export function observePage(scan: CrawlScan, observedAt: string, runId?: string): PageObservation {
  const fields = [...(scan.fields ?? []), ...(scan.forms ?? []).flatMap((f) => f.fields)].map(fieldLabelOf);
  return {
    ...(clean(scan.title) ? { title: clean(scan.title) } : {}),
    headings: uniq((scan.headings ?? []).map(clean)),
    actions: uniq([...(scan.controls ?? []).map((c) => c.label ?? ""), ...(scan.buttons ?? [])].map(visibleTextOf)),
    fields: uniq(fields),
    source: "crawl",
    observedAt,
    ...(runId ? { runId } : {}),
  };
}

export type KnowledgeDiff = {
  pagesObserved: string[];
  newPages: string[];
  accessChanges: Array<{ route: string; from: PageAccess["state"] | null; to: PageAccess["state"] }>;
  authRequired: string[];
  unreachable: string[];
  redirected: string[];
  apisObserved: string[];
  newApis: string[];
  missingApis: string[];
  thirdPartyHosts: string[];
};

/**
 * Merges one bounded crawl into the Brain. Every crawled route gets a page record (not only
 * pages with forms) with its access state and what was actually seen on it. Crawl-captured APIs
 * merge without touching spec-imported APIs: only crawl-sourced APIs accrue misses.
 */
export function computeCrawlKnowledgeUpdate(
  store: ApplicationModelStore,
  input: { scans: CrawlScan[]; apiCalls: CrawlApiCall[]; thirdPartyHosts?: Record<string, number>; redirects?: Array<{ url: string; finalUrl: string; status: number }>; observedAt: string; runId?: string },
): { next: ApplicationModelStore; diff: KnowledgeDiff } {
  const { observedAt, runId } = input;
  const pages: Record<string, ApplicationModelPage> = { ...store.pages };
  const diff: KnowledgeDiff = { pagesObserved: [], newPages: [], accessChanges: [], authRequired: [], unreachable: [], redirected: [], apisObserved: [], newApis: [], missingApis: [], thirdPartyHosts: Object.keys(input.thirdPartyHosts ?? {}).sort() };

  for (const scan of input.scans) {
    const route = routeOf(scan.url);
    const access = classifyPageAccess(scan, observedAt, runId);
    const observed = observePage(scan, observedAt, runId);
    const prior = pages[route];
    if (!prior) {
      pages[route] = { routeHint: route, forms: [], signature: computePageSignature([]), firstSeenAt: observedAt, lastSeenAt: observedAt, lastChangedAt: observedAt, consecutiveMisses: 0, access, observed };
      diff.newPages.push(route);
    } else {
      pages[route] = { ...prior, lastSeenAt: observedAt, consecutiveMisses: 0, access, observed };
    }
    if ((prior?.access?.state ?? null) !== access.state) diff.accessChanges.push({ route, from: prior?.access?.state ?? null, to: access.state });
    if (access.state === "auth_required") diff.authRequired.push(route);
    if (access.state === "unreachable") diff.unreachable.push(route);
    diff.pagesObserved.push(route);
  }

  for (const r of input.redirects ?? []) {
    const route = routeOf(r.url);
    const final = routeOf(r.finalUrl);
    if (route === final) continue;
    const toAuth = AUTH_PATH_RE.test(final) && !AUTH_PATH_RE.test(route);
    const access: PageAccess = {
      state: toAuth ? "auth_required" : "redirected", httpStatus: r.status, finalRoute: final,
      evidence: `requested ${route}, landed on ${final}`, source: "crawl", observedAt, ...(runId ? { runId } : {}),
    };
    const prior = pages[route];
    // What was seen belongs to the landing page, not this route - record access only, no elements.
    pages[route] = prior
      ? { ...prior, lastSeenAt: observedAt, consecutiveMisses: 0, access, observed: undefined }
      : { routeHint: route, forms: [], signature: computePageSignature([]), firstSeenAt: observedAt, lastSeenAt: observedAt, lastChangedAt: observedAt, consecutiveMisses: 0, access };
    if (!pages[route].observed) delete pages[route].observed;
    if (!prior) diff.newPages.push(route);
    if ((prior?.access?.state ?? null) !== access.state) diff.accessChanges.push({ route, from: prior?.access?.state ?? null, to: access.state });
    if (access.state === "auth_required") diff.authRequired.push(route); else diff.redirected.push(route);
    diff.pagesObserved.push(route);
  }

  const incoming = new Map<string, { method: string; path: string; origin: string; statuses: Set<number>; routes: Set<string> }>();
  for (const c of input.apiCalls) {
    const method = c.method.toUpperCase();
    if (method === "OPTIONS" || method === "HEAD") continue;
    const path = templateApiPath(c.path);
    const key = `${method} ${path}`;
    const e = incoming.get(key) ?? { method, path, origin: c.origin, statuses: new Set<number>(), routes: new Set<string>() };
    e.statuses.add(c.status);
    e.routes.add(normalizeRouteHint(c.route));
    incoming.set(key, e);
  }
  const apis: Record<string, ApplicationModelApi> = { ...store.apis };
  for (const [key, e] of incoming) {
    const prior = apis[key];
    const signature = sha1(key);
    apis[key] = {
      method: e.method, path: e.path, source: prior?.source === "api_spec" || (prior && !prior.source) ? prior.source ?? "api_spec" : "crawl",
      origin: e.origin,
      statuses: [...new Set([...(prior?.statuses ?? []), ...e.statuses])].sort(),
      observedOnRoutes: [...new Set([...(prior?.observedOnRoutes ?? []), ...e.routes])].sort().slice(0, 25),
      signature,
      firstSeenAt: prior?.firstSeenAt ?? observedAt,
      lastSeenAt: observedAt,
      lastChangedAt: prior?.lastChangedAt ?? observedAt,
      consecutiveMisses: 0,
    };
    diff.apisObserved.push(key);
    if (!prior) diff.newApis.push(key);
  }
  // Only crawl-sourced APIs whose pages were crawled this time can be "missed" - an API seen on
  // a page we didn't visit this cycle is not evidence of disappearance.
  const crawled = new Set(diff.pagesObserved);
  for (const [key, api] of Object.entries(store.apis)) {
    if (incoming.has(key) || api.source !== "crawl") continue;
    if (!(api.observedOnRoutes ?? []).some((r) => crawled.has(r))) continue;
    apis[key] = { ...api, consecutiveMisses: api.consecutiveMisses + 1 };
    diff.missingApis.push(key);
  }

  return { next: { ...store, pages, apis }, diff };
}

// ── User stories (expected behavior) ─────────────────────────────────────────

export type ParsedStory = { title: string; role?: string; goal?: string; benefit?: string; criteria: string[] };

export function parseUserStory(text: string): ParsedStory {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const pick = (re: RegExp) => { for (const l of lines) { const m = re.exec(l); if (m) return m[1].trim().replace(/[.,;]$/, ""); } return undefined; };
  const role = pick(/^as an?\s+(.+)$/i);
  const goal = pick(/^i (?:want|need|would like)(?: to)?\s+(.+)$/i);
  const benefit = pick(/^so that\s+(.+)$/i);
  const criteria: string[] = [];
  let inCriteria = false;
  for (const l of lines) {
    if (/^(acceptance criteria|ac|criteria)\s*:?\s*$/i.test(l)) { inCriteria = true; continue; }
    const bullet = /^(?:[-*•]|\d+[.)]|ac\s*\d+\s*[:.)-])\s*(.+)$/i.exec(l);
    const gherkin = /^(given|when|then|and)\b/i.test(l);
    if (bullet) criteria.push(bullet[1].trim());
    else if (gherkin) criteria.push(l);
    else if (inCriteria && !/^(as an?|i want|i need|so that)\b/i.test(l)) criteria.push(l);
  }
  const title = goal ? `${role ? `As ${role}, ` : ""}${goal}` : lines[0] ?? "Untitled story";
  return { title: title.slice(0, 200), ...(role ? { role } : {}), ...(goal ? { goal } : {}), ...(benefit ? { benefit } : {}), criteria: criteria.slice(0, 50) };
}

export const storyKey = (text: string) => sha1(text.replace(/\s+/g, " ").trim().toLowerCase()).slice(0, 12);

const STOP = new Set(["the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with", "is", "are", "be", "my", "your", "page", "user", "shows", "show", "can", "should", "must", "from", "when", "then", "given", "i", "it", "this", "that"]);
const norm = (s: string) => ` ${s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;

/**
 * Evidence that a criterion's referenced UI exists - by whole-word match of OBSERVED labels
 * (actions, fields, headings, titles) and route segments in the criterion text. Presence of
 * elements is not proof of behavior; status is never "verified" here.
 */
export function mapCriterionToEvidence(text: string, pages: Record<string, ApplicationModelPage>): StoryCriterion["evidence"] {
  const t = norm(text);
  const out: StoryCriterion["evidence"] = [];
  for (const page of Object.values(pages)) {
    const obs = page.observed;
    if (!obs || page.access?.state === "unreachable") continue;
    const labels = [...obs.actions, ...obs.fields, ...obs.headings, ...(obs.title ? [obs.title] : []), ...page.routeHint.split("/").filter((s) => s.length > 2)];
    const matched = new Set<string>();
    for (const label of labels) {
      const n = norm(label).trim();
      if (!n || n.length < 3 || STOP.has(n)) continue;
      if (t.includes(` ${n} `)) matched.add(label.trim());
    }
    if (matched.size) out.push({ routeHint: page.routeHint, matched: [...matched].slice(0, 10), source: "crawl", observedAt: obs.observedAt });
  }
  return out.sort((a, b) => b.matched.length - a.matched.length).slice(0, 5);
}

export function buildStoryRecord(text: string, store: ApplicationModelStore, now: string, runId?: string, prior?: ApplicationModelStory): ApplicationModelStory {
  const parsed = parseUserStory(text);
  const criteria: StoryCriterion[] = parsed.criteria.map((c, i) => {
    const evidence = mapCriterionToEvidence(c, store.pages);
    return { id: `ac${i + 1}`, text: c, status: evidence.length ? "elements_observed" : "no_evidence", evidence };
  });
  return {
    key: storyKey(text), title: parsed.title, text,
    ...(parsed.role ? { role: parsed.role } : {}), ...(parsed.goal ? { goal: parsed.goal } : {}), ...(parsed.benefit ? { benefit: parsed.benefit } : {}),
    criteria, source: "user_story", createdAt: prior?.createdAt ?? now, updatedAt: now, ...(runId ? { runId } : {}),
  };
}

export function upsertStory(store: ApplicationModelStore, story: ApplicationModelStory): ApplicationModelStore {
  return { ...store, stories: { ...(store.stories ?? {}), [story.key]: story } };
}

/** Re-maps every recorded story's criteria against the latest observations (stories are expected behavior; evidence is refreshed, never invented). */
export function refreshStoryEvidence(store: ApplicationModelStore, now: string): ApplicationModelStore {
  if (!store.stories) return store;
  const stories = Object.fromEntries(Object.entries(store.stories).map(([k, s]) => [k, {
    ...s,
    criteria: s.criteria.map((c) => { const evidence = mapCriterionToEvidence(c.text, store.pages); return { ...c, evidence, status: evidence.length ? "elements_observed" as const : "no_evidence" as const }; }),
    updatedAt: now,
  }]));
  return { ...store, stories };
}

// ── Repository inspection (declared, not observed) ───────────────────────────

const UI_ROUTE_RES = [/<Route\b[^>]*\bpath\s*=\s*["'`]([^"'`]+)["'`]/g, /\bpath\s*:\s*["'`](\/[^"'`]*)["'`]/g];
const API_ROUTE_RE = /\b(?:app|router|server|fastify|instance)\.(get|post|put|patch|delete)\s*(?:<[^>]*>)?\s*\(\s*["'`](\/[^"'`]*)["'`]/g;

/** Extracts routes DECLARED in source text. Pure: the caller supplies bounded {file, content} pairs. */
export function extractDeclaredRoutes(files: Array<{ file: string; content: string }>): Pick<DeclaredRoutes, "uiRoutes" | "apiRoutes"> {
  const ui = new Map<string, { path: string; file: string }>();
  const api = new Map<string, { method: string; path: string; file: string }>();
  for (const { file, content } of files) {
    const isUi = /\.(tsx|jsx)$/.test(file) || /routes?/i.test(file);
    if (isUi) for (const re of UI_ROUTE_RES) for (const m of content.matchAll(re)) if (m[1] && m[1] !== "*" && !ui.has(m[1])) ui.set(m[1], { path: m[1], file });
    for (const m of content.matchAll(API_ROUTE_RE)) {
      const key = `${m[1].toUpperCase()} ${m[2]}`;
      if (!api.has(key)) api.set(key, { method: m[1].toUpperCase(), path: m[2], file });
    }
  }
  return { uiRoutes: [...ui.values()].slice(0, 500), apiRoutes: [...api.values()].slice(0, 1000) };
}

// ── What to test next ────────────────────────────────────────────────────────

export type RecommendationKind =
  | "investigate_failure" | "cover_story_criterion" | "cover_page" | "cover_api"
  | "needs_credentials" | "inaccessible_page" | "unverifiable_criterion" | "verify_missing_page";

export type Recommendation = {
  id: string;
  kind: RecommendationKind;
  /** 1 = highest. Blocked/informational kinds use 9 and are never turned into tests. */
  priority: number;
  actionable: boolean;
  target: string;
  reason: string;
  basis: "observed" | "history" | "user_story";
  evidence: Array<{ source: string; observedAt: string | null; detail: string }>;
};

export type KnowledgeInputs = {
  store: ApplicationModelStore;
  coverage: Array<{ routeHint: string; testCaseId: string; lastResultStatus: string | null; lastRunAt: string | null }>;
  qaFailures: Array<{ testCaseId: string; routeHint: string; lastResultStatus: string; lastFailureMessage: string | null; lastRunAt: string | null }>;
  /** Paths of existing API test cases (from API Testing collections). */
  apiTestPaths: string[];
  testTitles?: Array<{ id: string; title: string }>;
  /** Routes existing tests claim to exercise - used only to choose what to observe next, never stored as fact. */
  testRouteClaims?: string[];
};

export type CoverageSummary = {
  pages: { observed: number; public: number; authRequired: number; unreachable: number; redirected: number; covered: number; uncovered: string[] };
  apis: { observed: number; covered: number; uncovered: string[] };
  stories: { count: number; criteria: number; elementsObserved: number; noEvidence: number };
  history: { failingTests: number; failingRoutes: string[] };
};

/** Segment-wise path match; ":id" (templated) and "{name}" (API Testing) segments match anything. */
export const pathMatches = (apiPath: string, testPath: string) => {
  let tp: string;
  try { tp = new URL(testPath, "http://x").pathname; } catch { return false; }
  const a = apiPath.split("/").filter(Boolean);
  const b = tp.split("/").filter(Boolean);
  if (a.length !== b.length) return false;
  const param = (x: string) => /^:\w+$/.test(x) || /^\{[^}]+\}$/.test(x);
  return a.every((seg, i) => seg === b[i] || param(seg) || param(b[i]));
};

export function summarizeCoverage(k: KnowledgeInputs): CoverageSummary {
  const pages = Object.values(k.store.pages).filter((p) => p.consecutiveMisses === 0);
  const coveredRoutes = new Set(k.coverage.map((c) => c.routeHint));
  const testable = pages.filter((p) => !p.access || p.access.state === "public" || p.access.state === "login_page");
  const crawlApis = Object.entries(k.store.apis).filter(([, a]) => a.consecutiveMisses === 0);
  const apiCovered = (a: ApplicationModelApi) => k.apiTestPaths.some((t) => pathMatches(a.path, t));
  const criteria = Object.values(k.store.stories ?? {}).flatMap((s) => s.criteria);
  return {
    pages: {
      observed: pages.length,
      public: pages.filter((p) => p.access?.state === "public").length,
      authRequired: pages.filter((p) => p.access?.state === "auth_required").length,
      unreachable: pages.filter((p) => p.access?.state === "unreachable").length,
      redirected: pages.filter((p) => p.access?.state === "redirected").length,
      covered: testable.filter((p) => coveredRoutes.has(p.routeHint)).length,
      uncovered: testable.filter((p) => !coveredRoutes.has(p.routeHint)).map((p) => p.routeHint).sort(),
    },
    apis: { observed: crawlApis.length, covered: crawlApis.filter(([, a]) => apiCovered(a)).length, uncovered: crawlApis.filter(([, a]) => !apiCovered(a)).map(([key]) => key).sort() },
    stories: { count: Object.keys(k.store.stories ?? {}).length, criteria: criteria.length, elementsObserved: criteria.filter((c) => c.status === "elements_observed").length, noEvidence: criteria.filter((c) => c.status === "no_evidence").length },
    history: { failingTests: k.qaFailures.length, failingRoutes: [...new Set(k.qaFailures.map((f) => f.routeHint))].sort() },
  };
}

/**
 * Decides what to test next using only what is known. Already-covered routes with passing
 * history are skipped (no repetition). Auth-gated pages and criteria without evidence are
 * reported as blocked/unverifiable, never planned as tests.
 */
export function recommendNextTests(k: KnowledgeInputs, opts: { limit?: number } = {}): Recommendation[] {
  const recs: Recommendation[] = [];
  const coveredRoutes = new Map<string, typeof k.coverage>();
  for (const c of k.coverage) coveredRoutes.set(c.routeHint, [...(coveredRoutes.get(c.routeHint) ?? []), c]);
  const titles = new Map((k.testTitles ?? []).map((t) => [t.id, t.title]));

  for (const f of k.qaFailures) {
    recs.push({
      id: `fail:${f.testCaseId}`, kind: "investigate_failure", priority: 1, actionable: true, target: f.routeHint,
      reason: `Existing test "${titles.get(f.testCaseId) ?? f.testCaseId}" last ${f.lastResultStatus} - classify (product defect vs test defect) before adding new coverage here`,
      basis: "history", evidence: [{ source: "test_run", observedAt: f.lastRunAt, detail: (f.lastFailureMessage ?? "").slice(0, 240) }],
    });
  }

  for (const story of Object.values(k.store.stories ?? {})) {
    for (const c of story.criteria) {
      if (c.status === "elements_observed") {
        recs.push({
          id: `ac:${story.key}:${c.id}`, kind: "cover_story_criterion", priority: 1, actionable: true, target: c.evidence[0]?.routeHint ?? "/",
          reason: `Acceptance criterion "${c.text}" - referenced elements were observed (${[...new Set(c.evidence.flatMap((e) => e.matched))].slice(0, 4).join(", ")}); behavior is not yet verified by a test`,
          basis: "user_story", evidence: c.evidence.map((e) => ({ source: e.source, observedAt: e.observedAt, detail: `${e.routeHint}: ${e.matched.join(", ")}` })),
        });
      } else {
        recs.push({
          id: `ac:${story.key}:${c.id}`, kind: "unverifiable_criterion", priority: 9, actionable: false, target: story.title,
          reason: `Acceptance criterion "${c.text}" has no matching element on any discovered page - not tested until the functionality is found, made accessible, or clarified`,
          basis: "user_story", evidence: [],
        });
      }
    }
  }

  for (const page of Object.values(k.store.pages)) {
    const access = page.access;
    if (page.consecutiveMisses > 0) {
      if (coveredRoutes.has(page.routeHint)) {
        recs.push({ id: `missing:${page.routeHint}`, kind: "verify_missing_page", priority: 3, actionable: true, target: page.routeHint,
          reason: `Previously observed page not seen in the last ${page.consecutiveMisses} discovery run(s); its ${coveredRoutes.get(page.routeHint)!.length} existing test(s) may be stale`,
          basis: "history", evidence: [{ source: "crawl", observedAt: page.lastSeenAt, detail: "last seen" }] });
      }
      continue;
    }
    if (access?.state === "auth_required") {
      recs.push({ id: `auth:${page.routeHint}`, kind: "needs_credentials", priority: 9, actionable: false, target: page.routeHint,
        reason: `Requires authentication (${access.evidence}) - cannot be explored or tested without approved test credentials`,
        basis: "observed", evidence: [{ source: access.source, observedAt: access.observedAt, detail: access.evidence }] });
      continue;
    }
    if (access?.state === "redirected") {
      recs.push({ id: `redirect:${page.routeHint}`, kind: "inaccessible_page", priority: 9, actionable: false, target: page.routeHint,
        reason: `Not reachable as a signed-out visitor (${access.evidence}); the reason (authentication, onboarding, or removal) is not assumed - existing tests targeting it cannot pass anonymously`,
        basis: "observed", evidence: [{ source: access.source, observedAt: access.observedAt, detail: access.evidence }] });
      continue;
    }
    if (access?.state === "unreachable") continue;
    if (coveredRoutes.has(page.routeHint)) continue; // already covered - do not repeat
    if (!page.observed && !page.forms.length) continue;
    const what = [
      page.forms.length ? `${page.forms.length} form(s)` : "",
      page.observed?.actions.length ? `${page.observed.actions.length} action(s)` : "",
      page.observed?.fields.length ? `${page.observed.fields.length} field(s)` : "",
    ].filter(Boolean).join(", ") || "content";
    recs.push({ id: `page:${page.routeHint}`, kind: "cover_page", priority: page.forms.length ? 2 : 3, actionable: true, target: page.routeHint,
      reason: `Observed page with ${what} and no existing test`,
      basis: "observed", evidence: [{ source: page.observed?.source ?? "crawl", observedAt: page.observed?.observedAt ?? page.lastSeenAt, detail: page.access?.evidence ?? "observed" }] });
  }

  for (const [key, api] of Object.entries(k.store.apis)) {
    if (api.consecutiveMisses > 0 || api.source !== "crawl") continue;
    if (k.apiTestPaths.some((t) => pathMatches(api.path, t))) continue;
    const failing = (api.statuses ?? []).some((s) => s >= 500);
    recs.push({ id: `api:${key}`, kind: "cover_api", priority: failing ? 2 : 3, actionable: true, target: key,
      reason: `API called by the app on ${(api.observedOnRoutes ?? []).slice(0, 3).join(", ") || "a discovered page"} (observed status ${(api.statuses ?? []).join("/")}) with no API test${failing ? " - server errors were observed" : ""}`,
      basis: "observed", evidence: [{ source: "crawl", observedAt: api.lastSeenAt, detail: `${api.origin ?? ""}${api.path}` }] });
  }

  recs.sort((a, b) => a.priority - b.priority || a.kind.localeCompare(b.kind) || a.target.localeCompare(b.target));
  return typeof opts.limit === "number" ? recs.slice(0, opts.limit) : recs;
}

/** Bounded incremental discovery: seed the next crawl with known pages that are stale, missing, or uncovered. */
export function incrementalSeedRoutes(store: ApplicationModelStore, coveredRoutes: Set<string>, now: string, max: number): string[] {
  const ageDays = (iso: string) => (Date.parse(now) - Date.parse(iso)) / 86_400_000;
  return Object.values(store.pages)
    .filter((p) => p.access?.state !== "auth_required" && p.access?.state !== "unreachable" && p.access?.state !== "redirected")
    .map((p) => ({ route: p.routeHint, score: (p.consecutiveMisses > 0 ? 3 : 0) + (!coveredRoutes.has(p.routeHint) ? 2 : 0) + (ageDays(p.lastSeenAt) > 7 ? 1 : 0) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.route.localeCompare(b.route))
    .slice(0, Math.max(0, max))
    .map((x) => x.route);
}
