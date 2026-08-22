import OpenAI from 'openai';
import type { RouteScan } from '../discover.js';
import type { TestCase, Step } from '../core/pattern.js';
import generatePlan from './generate-plan.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export type CoverageStatus = 'not_applicable' | 'covered' | 'partial' | 'runtime_required';

export type CoverageCategory =
  | 'happyPath' | 'negative' | 'boundary' | 'validation'
  | 'state' | 'navigation' | 'errorRecovery' | 'accessibility';

export type CoverageMatrix = Record<CoverageCategory, CoverageStatus>;

export type RichTestCase = TestCase & {
  evidence: 'observed' | 'inferred';
  validation: 'static' | 'runtime_required';
  coverageType: CoverageCategory | string;
  priority: number;
};

export type AITestPlan = {
  capabilities: string[];
  coverageMatrix: CoverageMatrix;
  gaps: string[];
  cases: RichTestCase[];          // all cases (for coverage panel)
  executableCases: RichTestCase[]; // cases that passed the hard gate (for emitSpecFile)
  observedCount: number;
  inferredCount: number;
  runtimeRequiredCount: number;
  familyCounts: Record<CoverageCategory, number>;
};

// ── Constants ─────────────────────────────────────────────────────────────────

const MODEL = process.env.URL_INSPECTOR_MODEL || 'gpt-4o-mini';
const PASS_TIMEOUT_MS = 90_000;
const MAX_LINKS_PER_PAGE = 30;
const MAX_BUTTONS_PER_PAGE = 60;
const MAX_FIELDS_PER_PAGE = 60;
const MAX_CONTROLS_PER_PAGE = 80;
const MAX_PAGES_IN_AI = 30;
const PAYLOAD_BYTE_CAP = 60_000;
const MAX_LINKS = MAX_LINKS_PER_PAGE;
const CASE_CAP = 50;
const VALID_STEP_KINDS = new Set(['goto', 'fill', 'click', 'expect-text', 'expect-visible', 'upload', 'custom']);

const STEP_SCHEMA = `Steps use only these kinds: goto, fill, click, expect-text, expect-visible, upload, custom.
Each step shape:
  goto:           { "kind": "goto",           "url": string }
  fill:           { "kind": "fill",           "selector": string, "value": string }
  click:          { "kind": "click",          "selector": string }
  expect-text:    { "kind": "expect-text",    "selector": string, "text": string }
  expect-visible: { "kind": "expect-visible", "selector": string }
  upload:         { "kind": "upload",         "selector": string, "path": string }
  custom:         { "kind": "custom",         "note": string }

Every test case MUST start with a goto step (kind="goto") using the route URL.
After goto, use fill/click steps to perform the action. End with at least one expect-text or expect-visible.
For custom steps, do NOT invent a selector — describe the action in "note" only.`;

const ALL_CATEGORIES: CoverageCategory[] = [
  'happyPath', 'negative', 'boundary', 'validation',
  'state', 'navigation', 'errorRecovery', 'accessibility',
];

// ── Scenario family feature flags ─────────────────────────────────────────────

const ENABLED_FAMILIES: ReadonlySet<string> = (() => {
  const s = new Set<string>();
  if (process.env.TM_URL_BUILDER_VALIDATION     === '1') s.add('validation');
  if (process.env.TM_URL_BUILDER_NEGATIVE       === '1') s.add('negative');
  if (process.env.TM_URL_BUILDER_BOUNDARY       === '1') s.add('boundary');
  if (process.env.TM_URL_BUILDER_STATE          === '1') s.add('state');
  if (process.env.TM_URL_BUILDER_ACCESSIBILITY  === '1') s.add('accessibility');
  if (process.env.TM_URL_BUILDER_ERROR_RECOVERY === '1') s.add('errorRecovery');
  if (s.size > 0) {
    console.log('[url-builder-ai] enabled scenario families:', [...s].join(', '));
  }
  return s;
})();

const FAMILY_INSTRUCTIONS: Record<string, string> = {
  validation: `
VALIDATION SCENARIOS — REQUIRED WHEN SUPPORTED (TM_URL_BUILDER_VALIDATION is on):
Governing rule: Generate up to at least 3 validation cases ONLY when observed controls provide evidence.
Never invent a validation rule that was not observed or strongly implied by native HTML semantics.

Observed evidence that justifies a validation scenario:
  • required attribute on a field
  • input type="email" / "tel" / "number" / "date" (format semantics are inherent to the type)
  • min / max / minlength / maxlength / pattern attribute
  • disabled state on a submit button
  • required checkbox, radio, or select

For each piece of evidence found, generate the corresponding case:
  • required field missing → assert submission blocked
  • type="email" with invalid format → assert format error
  • type="number" / min / max violated → assert error
  • required checkbox/radio/select unselected → assert blocked
  • submit button disabled when form invalid → assert button state

If an error-message element selector is not in OBSERVED_SELECTORS, use kind="custom" with
  validation="runtime_required" and a descriptive note — do NOT fabricate a selector.
If no observed evidence is found on the page, generate no validation cases and mark validation "not_applicable".
Name pattern: "Validation — [field or form] — [failure condition]"`,

  negative: `
NEGATIVE SCENARIOS — REQUIRED WHEN SUPPORTED (TM_URL_BUILDER_NEGATIVE is on):
Governing rule: Generate up to at least 3 negative cases ONLY when observed DOM provides evidence.
Never invent controls, auth forms, routes, or behavior to meet the minimum.

Observed evidence that justifies a negative scenario:
  • Login/auth form with username+password → wrong credentials case
  • Search input → invalid/empty search value case
  • Any form with required fields → empty-submit case
  • Route inventory shows protected routes → unauthorized access case

Only generate cases for evidence types actually observed. Mark family "partial" if fewer than 3 are supported.
Name pattern: "Negative — [action] — [invalid condition]"`,

  boundary: `
BOUNDARY SCENARIOS — REQUIRED WHEN SUPPORTED (TM_URL_BUILDER_BOUNDARY is on):
Governing rule: Distinguish KNOWN boundaries from EXPLORATORY boundaries. Do not fabricate constraints.

KNOWN BOUNDARY (evidence='observed', validation='static'):
  For fields with explicit DOM constraints, generate precise at-boundary and over-boundary tests:
  • maxlength="N" → test exactly N chars (accepted), N+1 chars (rejected or truncated)
  • minlength="N" → test N-1 chars (rejected), N chars (accepted)
  • min="A" max="B" on number/date → test A (accepted), A-1 (rejected), B (accepted), B+1 (rejected)
  • input type="number" → test zero and a negative value (semantics are inherent to the type)
  • input type="date" → test a boundary date when app context implies a constraint
  Set evidence="observed" and validation="static" for these cases.

EXPLORATORY BOUNDARY (evidence='inferred', validation='runtime_required'):
  For text fields without observed constraints where the field is interactive and likely bounded
  in practice (message bodies, notes, descriptions), generate at most 1 exploratory probe:
  • A very long string (200+ chars) to check whether the application silently truncates or rejects
  Set evidence="inferred" and validation="runtime_required" for these cases.
  These do NOT enter the runnable spec — that is correct and expected.

OMIT ENTIRELY:
  • Fields that have no type, no attributes, and appear to be static labels or display-only elements.
  • Fields for which there is no interactive evidence in OBSERVED_SELECTORS.

Mark family "partial" if only some fields have observed constraints.
Name pattern: "Boundary — [field] — [known: min/max/overflow] or [exploratory: long input probe]"`,

  state: `
STATE SCENARIOS — REQUIRED WHEN SUPPORTED (TM_URL_BUILDER_STATE is on):
Governing rule: Generate up to at least 3 state cases ONLY for states identifiable from observed DOM or route model.
Never invent application behavior or session state that was not observed.

Observed evidence that justifies a state scenario:
  • Protected route in route inventory → logged-in vs logged-out access
  • Toggle element (checkbox, switch, accordion, tab) → both states
  • Conditional UI elements (empty/populated list, disabled field) → observable from DOM
  • Form before/after submit (if the result state is directly observable as an assertion)

Mark family "partial" if only a subset of state conditions are observable.
Name pattern: "State — [element or route] — [state condition]"`,

  accessibility: `
ACCESSIBILITY SCENARIOS — REQUIRED WHEN SUPPORTED (TM_URL_BUILDER_ACCESSIBILITY is on):
Governing rule: Generate up to at least 2 accessibility cases based on ACTUAL observed roles, labels, and controls.
Never assert aria attributes or keyboard behavior that you cannot derive from the observed DOM.

Observed evidence that justifies an accessibility scenario:
  • Interactive controls in DOM → assert they have accessible names (kind="custom" validation="runtime_required")
  • Input fields with or without label elements → label association case
  • Form submit button → keyboard-reachable assertion (kind="custom" validation="runtime_required")
  • Role or aria-label attributes in OBSERVED_SELECTORS → use them as supporting evidence

All accessibility assertions must use kind="custom" with validation="runtime_required".
Name pattern: "Accessibility — [control or form] — [requirement]"`,

  errorRecovery: `
ERROR RECOVERY SCENARIOS — REQUIRED WHEN SUPPORTED (TM_URL_BUILDER_ERROR_RECOVERY is on):
Governing rule: Generate up to at least 2 error recovery cases ONLY when a failure condition can actually be established.
These are almost always runtime_required. Do not allow them into the executableCases gate unless the failure can be triggered deterministically.

Observed evidence that justifies an error recovery scenario:
  • Form that produces validation errors → correct the field and resubmit (validation="static" if error is DOM-observable)
  • Auth form → session expiry recovery (validation="runtime_required")
  • Any submit action → network/server failure recovery (validation="runtime_required", kind="custom")

Mark all server/network failure cases as validation="runtime_required".
Name pattern: "Error recovery — [failure type] — [recovery action]"`,
};

const ACTIVE_FAMILY_INSTRUCTIONS: string = [...ENABLED_FAMILIES]
  .map(f => FAMILY_INSTRUCTIONS[f] ?? '')
  .filter(Boolean)
  .join('\n');

// ── OpenAI client ─────────────────────────────────────────────────────────────

let _client: OpenAI | null = null;
function getClient(): OpenAI {
  if (!_client) {
    const key = process.env.OPENAI_API_KEY;
    if (!key) throw new Error('OPENAI_API_KEY is not set');
    _client = new OpenAI({ apiKey: key });
  }
  return _client;
}

// ── Selector normalization ────────────────────────────────────────────────────

function normalizeSelector(s: string): string {
  return s.trim().replace(/['"]/g, '"').replace(/\s+/g, ' ');
}

function toScans(input: RouteScan | RouteScan[]): RouteScan[] {
  return Array.isArray(input) ? input : [input];
}

function effectiveScanUrl(scan: RouteScan): string {
  return scan.finalUrl || scan.url;
}

function scanPath(scan: RouteScan): string {
  try {
    return new URL(effectiveScanUrl(scan)).pathname || '/';
  } catch {
    return '/';
  }
}

function buildObservedSelectorSet(
  locatorStore: { pages: Record<string, any> },
  scans: RouteScan[]
): Set<string> {
  const out = new Set<string>();
  // From locator store (semantic keys → resolved selectors)
  for (const page of Object.values(locatorStore.pages ?? {})) {
    for (const sel of Object.values(page.fields ?? {})) out.add(normalizeSelector(sel as string));
    for (const sel of Object.values(page.buttons ?? {})) out.add(normalizeSelector(sel as string));
    for (const sel of Object.values(page.links ?? {})) out.add(normalizeSelector(sel as string));
    for (const sel of Object.values(page.locators ?? {})) out.add(normalizeSelector(sel as string));
  }
  // Also include raw selectors from the scan itself so AI can reference buttons
  // even when the locator store hasn't been fully populated (e.g. first scan).
  for (const scan of scans) {
    for (const btn of scan.buttons ?? []) out.add(normalizeSelector(btn));
    for (const control of scan.controls ?? []) out.add(normalizeSelector(control.selector));
    for (const field of scan.fields ?? []) if (field.selector) out.add(normalizeSelector(field.selector));
    for (const form of scan.forms ?? []) {
      for (const sub of form.submitSelectors ?? []) out.add(normalizeSelector(sub));
    }
  }
  return out;
}

// ── Payload builder ───────────────────────────────────────────────────────────

function buildModelPayload(
  scan: RouteScan,
  locatorStore: { pages: Record<string, any> },
  options: { baseUrl: string; instructions?: string }
): { systemPrompt: string; userMessage: string } {
  const observedSelectors: Record<string, string> = {};
  for (const [pagePath, page] of Object.entries(locatorStore.pages ?? {})) {
    for (const [key, sel] of Object.entries(page.fields ?? {})) {
      observedSelectors[`${pagePath}::field::${key}`] = sel as string;
    }
    for (const [key, sel] of Object.entries(page.buttons ?? {})) {
      observedSelectors[`${pagePath}::button::${key}`] = sel as string;
    }
  }

  // Cap low-value links; keep high-value elements
  const links = (scan.links ?? []).slice(0, MAX_LINKS);

  const pageData = {
    url: scan.url,
    title: scan.title ?? '',
    forms: (scan.forms ?? []).map(f => ({
      selector: f.selector,
      fields: f.fields.map(fd => ({ name: fd.name, type: fd.type, required: fd.required })),
      submitSelectors: f.submitSelectors.slice(0, 3),
    })),
    fields: scan.fields.map(f => ({ name: f.name, type: f.type, required: f.required })),
    buttons: scan.buttons.slice(0, 20),
    links: links.map(l => {
      try { return new URL(l).pathname; } catch { return l; }
    }),
    fileInputs: scan.fileInputs ?? [],
  };

  const rawUserMsg = JSON.stringify({
    baseUrl: options.baseUrl,
    instructions: options.instructions ?? 'Full interactive coverage',
    pageData,
    OBSERVED_SELECTORS: observedSelectors,
  });

  // Truncate if over byte cap — drop links first
  let userMsg = rawUserMsg;
  if (Buffer.byteLength(userMsg, 'utf8') > PAYLOAD_BYTE_CAP) {
    const trimmed = { ...JSON.parse(rawUserMsg), pageData: { ...pageData, links: [] } };
    userMsg = JSON.stringify(trimmed);
  }

  const systemPrompt = `You are a senior SDET performing exhaustive behavioral test design.
Analyze the observed DOM scan provided. Your tasks:
1. List the page's CAPABILITIES based ONLY on observed elements.
2. Build a COVERAGE MATRIX using status values: not_applicable | covered | partial | runtime_required.
3. Generate an INITIAL TEST PLAN covering all applicable categories.

Coverage categories: happyPath, negative, boundary, validation, state, navigation, errorRecovery, accessibility.

STRICT SELECTOR RULE:
- Do NOT create or synthesize CSS selectors.
- Use ONLY selector values from OBSERVED_SELECTORS in the user message.
- If no observed selector supports a step, use kind="custom" with a "note" field instead.
- Never guess or invent a selector that is not in OBSERVED_SELECTORS.

For each test case:
- evidence: "observed" (DOM directly supports it) or "inferred" (strongly implied but not directly observable)
- validation: "static" (verifiable without runtime state) or "runtime_required" (depends on server behavior, session state, or DOM not yet present)

Steps use only these kinds: goto, fill, click, expect-text, expect-visible, upload, custom.
For custom steps, use a descriptive "note" field. Do not guess selectors for custom steps.

Return a JSON object with exactly this shape:
{
  "capabilities": string[],
  "coverageMatrix": { "happyPath": status, "negative": status, "boundary": status, "validation": status, "state": status, "navigation": status, "errorRecovery": status, "accessibility": status },
  "gaps": string[],
  "testCases": [{ "id": string, "name": string, "evidence": "observed"|"inferred", "validation": "static"|"runtime_required", "coverageType": string, "steps": [...] }]
}`;

  return { systemPrompt, userMessage: userMsg };
}

function buildMultiRouteModelPayload(
  scans: RouteScan[],
  locatorStore: { pages: Record<string, any> },
  options: { baseUrl: string; instructions?: string }
): { systemPrompt: string; userMessage: string } {
  const observedSelectors: Record<string, string> = {};
  for (const [pagePath, page] of Object.entries(locatorStore.pages ?? {})) {
    for (const [key, sel] of Object.entries(page.fields ?? {})) {
      observedSelectors[`${pagePath}::field::${key}`] = sel as string;
    }
    for (const [key, sel] of Object.entries(page.buttons ?? {})) {
      observedSelectors[`${pagePath}::button::${key}`] = sel as string;
    }
    for (const [key, sel] of Object.entries(page.links ?? {})) {
      observedSelectors[`${pagePath}::link::${key}`] = sel as string;
    }
    for (const [key, sel] of Object.entries(page.locators ?? {})) {
      observedSelectors[`${pagePath}::locator::${key}`] = sel as string;
    }
  }

  const pages = scans.slice(0, MAX_PAGES_IN_AI).map((scan) => ({
    url: effectiveScanUrl(scan),
    requestedUrl: scan.url,
    path: scanPath(scan),
    title: scan.title ?? '',
    status: scan.status,
    headings: (scan.headings ?? []).slice(0, 12),
    textSnippets: (scan.textSnippets ?? []).slice(0, 2),
    forms: (scan.forms ?? []).map(f => ({
      selector: f.selector,
      fields: f.fields.slice(0, MAX_FIELDS_PER_PAGE).map(fd => ({
        name: fd.name,
        type: fd.type,
        required: fd.required,
        label: fd.label,
        placeholder: fd.placeholder,
        selector: fd.selector,
        options: fd.options?.slice(0, 15),
        min: fd.min,
        max: fd.max,
        pattern: fd.pattern,
      })),
      submitSelectors: f.submitSelectors.slice(0, 5),
    })),
    fields: scan.fields.slice(0, MAX_FIELDS_PER_PAGE).map(f => ({
      name: f.name,
      type: f.type,
      required: f.required,
      label: f.label,
      placeholder: f.placeholder,
      selector: f.selector,
      options: f.options?.slice(0, 15),
      min: f.min,
      max: f.max,
      pattern: f.pattern,
    })),
    controls: (scan.controls ?? []).slice(0, MAX_CONTROLS_PER_PAGE).map(c => ({
      label: c.label,
      selector: c.selector,
      tag: c.tag,
      role: c.role,
      type: c.type,
      href: c.href,
      disabled: c.disabled,
    })),
    buttons: scan.buttons.slice(0, MAX_BUTTONS_PER_PAGE),
    links: (scan.links ?? []).slice(0, MAX_LINKS_PER_PAGE).map(l => {
      try {
        const url = new URL(l);
        return `${url.pathname || '/'}${url.search || ''}`;
      } catch {
        return l;
      }
    }),
    fileInputs: scan.fileInputs ?? [],
  }));

  const rawUserMsg = JSON.stringify({
    baseUrl: options.baseUrl,
    instructions: options.instructions ?? 'Full interactive coverage',
    routeInventory: {
      routeCount: scans.length,
      pages,
    },
    OBSERVED_SELECTORS: observedSelectors,
  });

  let userMessage = rawUserMsg;
  if (Buffer.byteLength(userMessage, 'utf8') > PAYLOAD_BYTE_CAP) {
    userMessage = JSON.stringify({
      ...JSON.parse(rawUserMsg),
      routeInventory: {
        routeCount: scans.length,
        pages: pages.map((page) => ({ ...page, textSnippets: [], links: [] })),
      },
    });
  }

  const systemPrompt = `You are a senior SDET performing exhaustive behavioral test design.
Analyze the observed multi-route DOM scan provided. Work route-by-route, then merge by user workflow/functionality. Your tasks:
1. List the application's CAPABILITIES based ONLY on observed routes and elements.
2. Build a COVERAGE MATRIX using status values: not_applicable | covered | partial | runtime_required.
3. For each scanned route, inspect its locators, forms, controls, headings, and text evidence.
4. Generate route-specific happy path, validation, negative, boundary, state, navigation, error recovery, and accessibility cases where supported by observed evidence.
5. Merge related route cases by functionality without dropping route coverage.

Coverage categories: happyPath, negative, boundary, validation, state, navigation, errorRecovery, accessibility.

STRICT SELECTOR RULE:
- Do NOT create or synthesize CSS selectors.
- Use ONLY selector values from OBSERVED_SELECTORS in the user message.
- If no observed selector supports a step, use kind="custom" with a "note" field instead.
- Never guess or invent a selector that is not in OBSERVED_SELECTORS.

For each test case:
- evidence: "observed" (DOM directly supports it) or "inferred" (strongly implied but not directly observable)
- validation: "static" (verifiable without runtime state) or "runtime_required" (depends on server behavior, session state, or DOM not yet present)
- Start each executable case with a goto step for the route under test.
- Cover every scanned route with at least a page-load or page-identity case.
- Prefer multiple focused cases per form/control instead of one generic case.
- Set group.page or page to the route path each case belongs to.
- Do not create final cases for an unauthenticated login-only scan; report an authentication gap instead.

Steps use only these kinds: goto, fill, click, expect-text, expect-visible, upload, custom.
For custom steps, use a descriptive "note" field. Do not guess selectors for custom steps.

Return a JSON object with exactly this shape:
{
  "capabilities": string[],
  "coverageMatrix": { "happyPath": status, "negative": status, "boundary": status, "validation": status, "state": status, "navigation": status, "errorRecovery": status, "accessibility": status },
  "gaps": string[],
  "testCases": [{ "id": string, "name": string, "evidence": "observed"|"inferred", "validation": "static"|"runtime_required", "coverageType": string, "steps": [...] }]
}`;

  const fullSystemPrompt = ACTIVE_FAMILY_INSTRUCTIONS
    ? `${systemPrompt}\n\n${ACTIVE_FAMILY_INSTRUCTIONS}`
    : systemPrompt;

  return { systemPrompt: fullSystemPrompt, userMessage };
}

// ── AI calls ──────────────────────────────────────────────────────────────────

const RETRY_DELAYS_MS = [1400, 2800]; // slightly above the ~1s the API requests

async function callAI(systemPrompt: string, userMessage: string): Promise<unknown> {
  const openai = getClient();
  const MAX_RETRIES = RETRY_DELAYS_MS.length;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PASS_TIMEOUT_MS);
    try {
      const completion = await openai.chat.completions.create(
        {
          model: MODEL,
          temperature: 0.15,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMessage },
          ],
        },
        { signal: controller.signal }
      );
      const raw = completion.choices[0]?.message?.content ?? '{}';
      return JSON.parse(raw);
    } catch (err: any) {
      const status: number = err?.status ?? err?.statusCode ?? 0;
      const isRetryable = status === 429 || status === 408 || (status >= 500 && status <= 599);
      if (isRetryable && attempt < MAX_RETRIES) {
        const delay = RETRY_DELAYS_MS[attempt];
        console.warn(`[url-builder-ai] callAI retry ${attempt + 1}/${MAX_RETRIES} (status=${status}) after ${delay}ms`);
        await new Promise(res => setTimeout(res, delay));
        continue;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error('[url-builder-ai] callAI: max retries exhausted');
}

// ── Deterministic validation ──────────────────────────────────────────────────

type RawAIStep = { kind?: string; url?: string; selector?: string; value?: string; text?: string; path?: string; note?: string };
type RawAICase = {
  id?: string;
  name?: string;
  evidence?: string;
  validation?: string;
  coverageType?: string;
  page?: string;
  group?: { page?: string; url?: string };
  steps?: RawAIStep[];
};

function validateAndNormalizeStep(
  step: RawAIStep,
  observedSelectors: Set<string>,
  knownTexts: Set<string>
): Step {
  // Normalize common AI step-kind variants to canonical kinds.
  // Models frequently use test-framework synonyms (navigate, type, assert, etc.)
  // even when the prompt specifies exact kind names.
  const KIND_ALIASES: Record<string, string> = {
    navigate: 'goto', go: 'goto', open: 'goto', visit: 'goto',
    type: 'fill', input: 'fill', enter: 'fill', set: 'fill',
    press: 'click', tap: 'click', select: 'click',
    assert: 'expect-text', verify: 'expect-text', check: 'expect-text', assertText: 'expect-text',
    assertVisible: 'expect-visible', isVisible: 'expect-visible', checkVisible: 'expect-visible',
  };
  const rawKind = step.kind ?? (step as any).action ?? (step as any).type ?? (step as any).step ?? (step as any).verb ?? 'custom';
  const kind = KIND_ALIASES[rawKind] ?? rawKind;

  if (!VALID_STEP_KINDS.has(kind)) {
    return { kind: 'custom', note: `Unsupported step kind: ${rawKind}` } as any;
  }

  if (kind === 'fill' || kind === 'click' || kind === 'expect-visible' || kind === 'upload') {
    const raw = step.selector ?? '';
    const norm = normalizeSelector(raw);
    if (!observedSelectors.has(norm)) {
      return { kind: 'custom', note: `Unobserved selector: ${raw || '(none)'}` } as any;
    }
    if (kind === 'fill') return { kind, selector: raw, value: step.value ?? '' };
    if (kind === 'click') return { kind, selector: raw };
    if (kind === 'expect-visible') return { kind, selector: raw };
    if (kind === 'upload') return { kind, selector: raw, path: step.path ?? '__placeholder__' };
  }

  if (kind === 'goto') return { kind, url: step.url ?? '/' };

  if (kind === 'expect-text') {
    const text = step.text ?? '';
    if (!text) return { kind: 'custom', note: 'expect-text with no text value' } as any;
    // Allow any non-empty text assertion. The AI may assert text that only appears
    // after navigation (e.g. "Dashboard" after login) which won't be in knownTexts
    // from the current page scan — that is correct AI behaviour, not a fabrication.
    return { kind, text };
  }

  // custom
  return { kind: 'custom', note: step.note ?? 'Custom step' } as any;
}

function buildKnownTexts(scans: RouteScan[]): Set<string> {
  const texts = new Set<string>();
  for (const scan of scans) {
    if (scan.title) texts.add(scan.title.toLowerCase());
    for (const heading of scan.headings ?? []) texts.add(heading.toLowerCase());
    for (const btn of scan.buttons ?? []) texts.add(btn.toLowerCase());
    for (const control of scan.controls ?? []) if (control.label) texts.add(control.label.toLowerCase());
    for (const link of scan.links ?? []) {
      try { texts.add(new URL(link).pathname.toLowerCase()); } catch { texts.add(link.toLowerCase()); }
    }
    for (const f of scan.fields ?? []) {
      if (f.name) texts.add(f.name.toLowerCase());
      if (f.label) texts.add(f.label.toLowerCase());
    }
  }
  return texts;
}

function pathFromStepUrl(value?: string): string {
  if (!value) return '/';
  try {
    return new URL(value, 'http://testmind.local').pathname || '/';
  } catch {
    return value.startsWith('/') ? value : `/${value}`;
  }
}

function validateCase(
  raw: RawAICase,
  observedSelectors: Set<string>,
  knownTexts: Set<string>,
  seenIds: Set<string>,
  seenNames: Set<string>
): RichTestCase | null {
  const name = (raw.name ?? '').trim();
  const nameLower = name.toLowerCase();
  if (!name || seenNames.has(nameLower)) return null;

  const rawId = raw.id ?? `tc-${Math.random().toString(36).slice(2)}`;
  const id = seenIds.has(rawId) ? `${rawId}-${Date.now()}` : rawId;
  seenIds.add(id);
  seenNames.add(nameLower);

  const steps = (raw.steps ?? []).map(s => validateAndNormalizeStep(s, observedSelectors, knownTexts));

  const evidence = raw.evidence === 'observed' ? 'observed' : 'inferred';
  const validation = raw.validation === 'runtime_required' ? 'runtime_required' : 'static';
  const coverageType = (raw.coverageType ?? 'happyPath') as CoverageCategory;

  const hasActionable = steps.some(s => ['fill', 'click', 'goto'].includes(s.kind));
  const hasAssertion = steps.some(s => ['expect-text', 'expect-visible'].includes(s.kind));

  if (!hasActionable) return null; // exclude entirely

  const finalValidation: 'static' | 'runtime_required' = (!hasAssertion) ? 'runtime_required' : validation;
  const firstGoto = steps.find((s): s is Extract<Step, { kind: 'goto' }> => s.kind === 'goto');
  const groupPage = raw.group?.page || raw.group?.url || raw.page || pathFromStepUrl(firstGoto?.url);

  return {
    id, name, steps,
    evidence, validation: finalValidation, coverageType,
    priority: 0, // assigned later
    group: { page: pathFromStepUrl(groupPage) },
  };
}

// ── Ranking ───────────────────────────────────────────────────────────────────

const HIGH_VALUE = new Set(['happyPath', 'negative', 'validation']);

function assignPriority(tc: RichTestCase): number {
  if (tc.evidence === 'observed' && tc.validation === 'static' && HIGH_VALUE.has(tc.coverageType)) return 1;
  if (tc.evidence === 'observed' && tc.validation === 'static') return 2;
  if (tc.evidence === 'observed' && tc.validation === 'runtime_required') return 3;
  if (tc.evidence === 'inferred' && tc.validation === 'static') return 4;
  return 5; // inferred + runtime_required
}

// ── Coverage matrix parsing ───────────────────────────────────────────────────

function parseCoverageMatrix(raw: unknown): CoverageMatrix {
  const valid: CoverageStatus[] = ['not_applicable', 'covered', 'partial', 'runtime_required'];
  const result = {} as CoverageMatrix;
  for (const cat of ALL_CATEGORIES) {
    const v = (raw as any)?.[cat];
    result[cat] = valid.includes(v) ? v : 'not_applicable';
  }
  return result;
}

// ── Fallback matrix from deterministic cases ──────────────────────────────────

function deriveMatrixFromDeterministicCases(cases: TestCase[]): CoverageMatrix {
  const matrix: CoverageMatrix = Object.fromEntries(
    ALL_CATEGORIES.map(c => [c, 'not_applicable' as CoverageStatus])
  ) as CoverageMatrix;

  for (const tc of cases) {
    const name = tc.name.toLowerCase();
    const steps = tc.steps;

    const hasFill = steps.some(s => s.kind === 'fill');
    const hasClick = steps.some(s => s.kind === 'click');
    const hasGoto = steps.some(s => s.kind === 'goto');
    const isNav = name.includes('navigate') || name.includes('→');
    const hasUpload = steps.some(s => s.kind === 'upload');

    if (hasFill && hasClick) matrix.happyPath = 'covered';
    if (isNav && hasGoto) matrix.navigation = 'covered';
    if (hasUpload) matrix.state = 'partial';
  }

  return matrix;
}

// ── Module-level helpers ──────────────────────────────────────────────────────

function pickCasesFromResult(result: unknown): RawAICase[] {
  const r = result as any;
  return Array.isArray(r?.testCases) ? r.testCases :
         Array.isArray(r?.cases)     ? r.cases     :
         Array.isArray(r?.tests)     ? r.tests     : [];
}

function familyHasEvidence(family: string, scans: RouteScan[]): boolean {
  switch (family) {
    case 'validation':
      return scans.some(s =>
        s.fields?.some(f => f.required || ['email', 'tel', 'number', 'date'].includes(f.type ?? '')) ||
        s.forms?.some(form => form.fields.some(f => f.required))
      );
    case 'negative':
      return scans.some(s =>
        s.fields?.some(f => ['password', 'email'].includes(f.type ?? '')) ||
        (s.forms?.length ?? 0) > 0
      );
    case 'boundary':
      // text/textarea allowed so exploratory probes (inferred/runtime_required) are reachable;
      // the prompt decides observed vs exploratory, not this gate.
      return scans.some(s =>
        s.fields?.some(f =>
          f.min !== undefined || f.max !== undefined ||
          (f as any).minLength !== undefined || (f as any).maxLength !== undefined ||
          f.pattern ||
          ['number', 'date', 'email', 'tel', 'text', 'textarea'].includes(f.type ?? '')
        )
      );
    case 'state':
      return scans.some(s =>
        s.controls?.some(c =>
          ['checkbox', 'radio'].includes((c as any).type ?? '') ||
          (c as any).role === 'switch' || (c as any).role === 'checkbox'
        ) || scans.length > 1
      );
    case 'accessibility':
      return scans.some(s => (s.controls?.length ?? 0) > 0 || (s.buttons?.length ?? 0) > 0);
    case 'errorRecovery':
      return scans.some(s => (s.forms?.length ?? 0) > 0 || s.fields?.some(f => f.required));
    default:
      return false;
  }
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function generatePlanWithAI(
  scanInput: RouteScan | RouteScan[],
  locatorStore: { pages: Record<string, any> },
  options: { baseUrl: string; instructions?: string }
): Promise<AITestPlan> {
  const scans = toScans(scanInput);
  const primaryScan = scans[0];
  const observedSelectors = buildObservedSelectorSet(locatorStore, scans);
  const knownTexts = buildKnownTexts(scans);

  let pass1Result: any = {};
  let pass2Result: any = {};
  let userMessage = '';

  try {
    // ── Pass 1 ────────────────────────────────────────────────────────────────
    const { systemPrompt, userMessage: msg } = buildMultiRouteModelPayload(scans, locatorStore, options);
    userMessage = msg;
    pass1Result = await callAI(systemPrompt, userMessage);

    // ── Pass 2 — Coverage Critic ──────────────────────────────────────────────
    const criticBase = `You reviewed an initial test plan. Your job:
1. Identify MISSING or UNDER-REPRESENTED coverage categories from the coverageMatrix.
2. Identify scanned routes that have too little coverage or missing page identity assertions.
3. Add ONLY tests that fill gaps supported by the observed page capabilities.
4. Do not repeat test cases that are already covered.
5. Apply the same STRICT SELECTOR RULE: use ONLY selectors from OBSERVED_SELECTORS. No fabricated selectors.
   If no observed selector fits a step, use kind="custom" with a note field.

Return a JSON object:
{
  "additionalTestCases": [...same shape as testCases...],
  "revisedCoverageMatrix": { ...same shape... },
  "remainingGaps": string[]
}`;

    const criticSystemPrompt = ACTIVE_FAMILY_INSTRUCTIONS
      ? `${criticBase}\n\nFor any enabled scenario families below, add gap-filling cases that the initial plan missed — subject to the same evidence-first governing rule stated in each family block:\n${ACTIVE_FAMILY_INSTRUCTIONS}`
      : criticBase;

    const criticUserMsg = JSON.stringify({
      OBSERVED_SELECTORS: Object.fromEntries([...observedSelectors].map((s, i) => [`sel_${i}`, s])),
      pass1Output: {
        capabilities: pass1Result.capabilities,
        coverageMatrix: pass1Result.coverageMatrix,
        gaps: pass1Result.gaps,
        testCases: pass1Result.testCases,
      },
    });

    pass2Result = await callAI(criticSystemPrompt, criticUserMsg);
  } catch (err) {
    console.error('[url-builder-ai] AI pipeline failed, using deterministic fallback:',
      err instanceof Error ? err.message : String(err));
  }

  // ── Merge raw AI output ───────────────────────────────────────────────────
  const pickAdditional = (result: any): RawAICase[] =>
    Array.isArray(result?.additionalTestCases) ? result.additionalTestCases :
    Array.isArray(result?.additionalCases)     ? result.additionalCases     :
    Array.isArray(result?.testCases)           ? result.testCases           : [];

  const rawCases: RawAICase[] = [
    ...pickCasesFromResult(pass1Result),
    ...pickAdditional(pass2Result),
  ];

  const p1Keys = Object.keys(pass1Result ?? {}).join(', ') || '(empty)';
  const p2Keys = Object.keys(pass2Result ?? {}).join(', ') || '(empty)';
  console.log(`[url-builder-ai] pass1 keys: ${p1Keys}`);
  console.log(`[url-builder-ai] pass2 keys: ${p2Keys}`);
  console.log(`[url-builder-ai] raw: pass1=${pickCasesFromResult(pass1Result).length} pass2=${pickAdditional(pass2Result).length} total=${rawCases.length}`);

  // ── Validate & normalize ──────────────────────────────────────────────────
  const seenIds = new Set<string>();
  const seenNames = new Set<string>();
  const validated: RichTestCase[] = [];

  let firstRejectLogged = false;
  for (const raw of rawCases) {
    const tc = validateCase(raw, observedSelectors, knownTexts, seenIds, seenNames);
    if (tc) {
      validated.push(tc);
    } else if (!firstRejectLogged) {
      firstRejectLogged = true;
      const rawKinds = (raw.steps ?? []).map((s: any) =>
        s.kind ?? s.action ?? s.type ?? s.step ?? s.verb ?? `(none:keys=${Object.keys(s).join(',')})`
      );
      const name = raw.name ?? '(empty)';
      console.log(`[url-builder-ai] first-reject: name="${name}" rawKinds=[${rawKinds.join(', ')}] hasGoto=${rawKinds.includes('goto')} hasNavigate=${rawKinds.includes('navigate')}`);
    }
  }

  console.log(`[url-builder-ai] validated=${validated.length}/${rawCases.length} cases`);

  // ── Fallback if needed ────────────────────────────────────────────────────
  if (validated.length < 2) {
    console.warn(`[url-builder-ai] validated < 2 — using deterministic fallback`);
    const fallbackPlan = generatePlan({
      env: { baseUrl: options.baseUrl },
      component: new URL(primaryScan?.url ?? options.baseUrl).hostname,
      requirement: options.instructions ?? 'Full interactive coverage',
      risks: [],
      discovered: {
        routes: scans.map((scan) => effectiveScanUrl(scan)),
        forms: scans.flatMap((scan) => scan.fields ?? []),
        scans,
      },
    }, 'sdet');

    const fallbackCases: RichTestCase[] = fallbackPlan.cases.map((tc: TestCase) => ({
      ...tc,
      evidence: 'inferred' as const,
      validation: 'static' as const,
      coverageType: 'happyPath',
      priority: 4,
    }));

    return {
      capabilities: [],
      coverageMatrix: deriveMatrixFromDeterministicCases(fallbackPlan.cases),
      gaps: ['AI generation unavailable — deterministic baseline used'],
      cases: fallbackCases,
      executableCases: fallbackCases,
      observedCount: 0,
      inferredCount: fallbackCases.length,
      runtimeRequiredCount: 0,
      familyCounts: Object.fromEntries(ALL_CATEGORIES.map(c => [c, 0])) as Record<CoverageCategory, number>,
    };
  }

  // ── Assign priority & rank ────────────────────────────────────────────────
  const deterministicPlan = generatePlan({
    env: { baseUrl: options.baseUrl },
    component: new URL(primaryScan?.url ?? options.baseUrl).hostname,
    requirement: options.instructions ?? 'Full interactive coverage',
    risks: [],
    discovered: {
      routes: scans.map((scan) => effectiveScanUrl(scan)),
      forms: scans.flatMap((scan) => scan.fields ?? []),
      scans,
    },
  }, 'sdet');

  const deterministicTarget = Math.min(CASE_CAP, Math.max(8, scans.length * 3));
  for (const tc of deterministicPlan.cases) {
    if (validated.length >= deterministicTarget) break;
    const nameLower = tc.name.toLowerCase();
    if (seenNames.has(nameLower)) continue;
    seenNames.add(nameLower);
    seenIds.add(tc.id);
    validated.push({
      ...tc,
      evidence: 'observed' as const,
      validation: 'static' as const,
      coverageType: tc.name.toLowerCase().includes('navigate') ? 'navigation' : 'happyPath',
      priority: 2,
    });
  }

  for (const tc of validated) tc.priority = assignPriority(tc);
  validated.sort((a, b) => a.priority - b.priority);

  const all = validated.slice(0, CASE_CAP);
  const executableCases = all.filter(
    tc => tc.validation === 'static'
      && tc.steps.some(s => ['fill', 'click', 'goto'].includes(s.kind))
      && tc.steps.some(s => ['expect-text', 'expect-visible'].includes(s.kind))
  );

  // ── Build coverage matrix ─────────────────────────────────────────────────
  const finalMatrix = parseCoverageMatrix(
    pass2Result?.revisedCoverageMatrix ?? pass1Result?.coverageMatrix
  );

  // Reconcile matrix against actual generated cases: if the AI wrote
  // "not_applicable" for a family but cases with that coverageType exist,
  // correct it so the panel reflects reality.
  for (const tc of all) {
    const ct = tc.coverageType as CoverageCategory;
    if (!ALL_CATEGORIES.includes(ct)) continue;
    if (finalMatrix[ct] === 'not_applicable') {
      finalMatrix[ct] = tc.validation === 'runtime_required' ? 'runtime_required' : 'partial';
    }
  }

  const gaps: string[] = [
    ...(Array.isArray(pass1Result?.gaps) ? pass1Result.gaps : []),
    ...(Array.isArray(pass2Result?.remainingGaps) ? pass2Result.remainingGaps : []),
  ].filter((g, i, arr) => arr.indexOf(g) === i); // dedupe

  const observedCount = all.filter(tc => tc.evidence === 'observed').length;
  const inferredCount = all.filter(tc => tc.evidence === 'inferred').length;
  const runtimeRequiredCount = all.filter(tc => tc.validation === 'runtime_required').length;
  const familyCounts = Object.fromEntries(
    ALL_CATEGORIES.map(cat => [cat, all.filter(tc => tc.coverageType === cat).length])
  ) as Record<CoverageCategory, number>;

  return {
    capabilities: Array.isArray(pass1Result?.capabilities) ? pass1Result.capabilities : [],
    coverageMatrix: finalMatrix,
    gaps,
    cases: all,
    executableCases,
    observedCount,
    inferredCount,
    runtimeRequiredCount,
    familyCounts,
  };
}

// ── Post-aggregate family fill ────────────────────────────────────────────────
// Called ONCE in url-inspector.ts after all per-route cases are combined.
// Uses all scans for cross-route evidence detection; makes at most 3 AI calls total.

export type FamilyFillResult = {
  cases: RichTestCase[];
  matrixPatch: Partial<Record<CoverageCategory, CoverageStatus>>;
};

export async function fillMissingFamilies(
  scans: RouteScan[],
  locatorStore: { pages: Record<string, any> },
  options: { baseUrl: string; instructions?: string },
  existingCases: RichTestCase[]
): Promise<FamilyFillResult> {
  if (ENABLED_FAMILIES.size === 0) return { cases: [], matrixPatch: {} };

  const observedSelectors = buildObservedSelectorSet(locatorStore, scans);
  const knownTexts = buildKnownTexts(scans);
  const seenIds = new Set(existingCases.map(tc => tc.id));
  const seenNames = new Set(existingCases.map(tc => tc.name.toLowerCase()));

  const generatedFamilies = new Set(existingCases.map(tc => tc.coverageType));
  const toFill = [...ENABLED_FAMILIES].filter(
    f => !generatedFamilies.has(f as CoverageCategory) && familyHasEvidence(f, scans)
  );

  const evidenceLog = [...ENABLED_FAMILIES].map(f =>
    `${f}=${familyHasEvidence(f, scans) ? 'yes' : 'no'}`
  ).join(', ');
  console.log(`[url-builder-ai] fillMissingFamilies evidence: ${evidenceLog}`);

  if (toFill.length === 0) return { cases: [], matrixPatch: {} };

  console.log(`[url-builder-ai] fillMissingFamilies targeting: ${toFill.join(', ')}`);

  const { userMessage } = buildMultiRouteModelPayload(scans, locatorStore, options);

  const fillResults = await Promise.allSettled(
    toFill.map(async family => {
      const fillPrompt = `You are a senior SDET. The initial test plan generated zero "${family}" test cases for this application.
Your ONLY task is to generate 3–5 ${family} test cases now. Do not generate happyPath or navigation cases.

${FAMILY_INSTRUCTIONS[family] ?? ''}

STRICT SELECTOR RULE: Use ONLY selectors from OBSERVED_SELECTORS in the user message.
Use kind="custom" with a note when no observed selector applies.

${STEP_SCHEMA}

Return JSON with exactly this shape — no extra keys, no prose outside the JSON:
{
  "testCases": [
    {
      "id": "tc-<short-id>",
      "name": "Descriptive scenario name",
      "evidence": "observed",
      "validation": "static",
      "coverageType": "${family}",
      "steps": [
        { "kind": "goto", "url": "<route URL from baseUrl in user message>" },
        { "kind": "fill", "selector": "<selector from OBSERVED_SELECTORS>", "value": "<test value>" },
        { "kind": "click", "selector": "<selector from OBSERVED_SELECTORS>" },
        { "kind": "expect-text", "selector": "<selector from OBSERVED_SELECTORS>", "text": "<expected text>" }
      ]
    }
  ]
}`;
      const result = await callAI(fillPrompt, userMessage);
      return { family, cases: pickCasesFromResult(result) };
    })
  );

  const added: RichTestCase[] = [];
  for (const r of fillResults) {
    if (r.status === 'fulfilled') {
      let passed = 0;
      let rejected = 0;
      for (const raw of r.value.cases) {
        // AI sometimes omits goto despite the prompt — rescue by prepending baseUrl goto
        const hasGoto = (raw.steps ?? []).some((s: any) => s.kind === 'goto');
        const rescuedSteps = hasGoto
          ? raw.steps
          : [{ kind: 'goto', url: options.baseUrl }, ...(raw.steps ?? [])];
        const groundedRaw = { ...raw, coverageType: r.value.family, steps: rescuedSteps };
        const tc = validateCase(groundedRaw, observedSelectors, knownTexts, seenIds, seenNames);
        if (tc) { added.push(tc); passed++; } else rejected++;
      }
      console.log(`[url-builder-ai] fill ${r.value.family}: ${r.value.cases.length} raw → ${passed} validated, ${rejected} rejected`);
    } else {
      console.warn(`[url-builder-ai] fill failed (${r.reason?.constructor?.name ?? 'Error'}): ${(r as PromiseRejectedResult).reason?.message ?? 'unknown'}`);
    }
  }
  console.log(`[url-builder-ai] fillMissingFamilies added=${added.length}`);

  const matrixPatch: Partial<Record<CoverageCategory, CoverageStatus>> = {};
  for (const family of toFill) {
    const fc = added.filter(tc => tc.coverageType === family);
    if (fc.length === 0) continue;
    const hasStatic = fc.some(tc => tc.validation === 'static');
    matrixPatch[family as CoverageCategory] = hasStatic ? 'covered' : 'runtime_required';
  }

  return { cases: added, matrixPatch };
}
