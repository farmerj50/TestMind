import OpenAI from 'openai';
import type { RouteDiscoveryHint, RouteScan } from '../discover.js';

const MODEL = process.env.URL_INSPECTOR_ROUTE_MODEL || process.env.URL_INSPECTOR_MODEL || 'gpt-4o-mini';
const PASS_TIMEOUT_MS = 20_000;
const PAYLOAD_BYTE_CAP = 35_000;
const MAX_PAGES = 12;
const MAX_CONTROLS_PER_PAGE = 80;
const MAX_LINKS_PER_PAGE = 40;

let client: OpenAI | null = null;

function getClient(): OpenAI | null {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;
  if (!client) client = new OpenAI({ apiKey: key });
  return client;
}

function effectiveScanUrl(scan: RouteScan): string {
  return scan.finalUrl || scan.url;
}

function scanPath(scan: RouteScan): string {
  try {
    const url = new URL(effectiveScanUrl(scan));
    return `${url.pathname || '/'}${url.search || ''}`;
  } catch {
    return '/';
  }
}

function trimPayload(raw: string): string {
  if (Buffer.byteLength(raw, 'utf8') <= PAYLOAD_BYTE_CAP) return raw;
  const parsed = JSON.parse(raw);
  return JSON.stringify({
    ...parsed,
    pages: (parsed.pages ?? []).map((page: any) => ({
      ...page,
      textSnippets: [],
      links: (page.links ?? []).slice(0, 10),
      controls: (page.controls ?? []).slice(0, 35),
    })),
  });
}

function normalizeRoutes(raw: unknown, baseUrl: string): string[] {
  if (!Array.isArray(raw)) return [];
  const base = new URL(baseUrl);
  const out = new Set<string>();

  for (const value of raw) {
    if (typeof value !== 'string' || !value.trim()) continue;
    try {
      const url = new URL(value.trim(), base);
      if (url.origin !== base.origin) continue;
      url.hash = '';
      out.add(url.toString());
    } catch {
      // ignore malformed AI output
    }
  }

  return Array.from(out).slice(0, 40);
}

function normalizeSelectors(raw: unknown, observedSelectors: Set<string>): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();

  for (const value of raw) {
    if (typeof value !== 'string') continue;
    const selector = value.trim();
    if (!selector || !observedSelectors.has(selector) || seen.has(selector)) continue;
    seen.add(selector);
    out.push(selector);
  }

  return out.slice(0, 30);
}

export async function suggestRouteDiscoveryWithAI(
  scans: RouteScan[],
  options: { baseUrl: string; instructions?: string; remainingPages?: number },
): Promise<RouteDiscoveryHint> {
  const openai = getClient();
  if (!openai || options.remainingPages === 0) {
    return { routes: [], selectors: [], coverageGoals: [], rationale: [] };
  }

  const pages = scans.slice(-MAX_PAGES).map((scan) => ({
    url: effectiveScanUrl(scan),
    path: scanPath(scan),
    title: scan.title ?? '',
    headings: (scan.headings ?? []).slice(0, 10),
    textSnippets: (scan.textSnippets ?? []).slice(0, 2),
    links: (scan.links ?? []).slice(0, MAX_LINKS_PER_PAGE).map((link) => {
      try {
        const url = new URL(link);
        return `${url.pathname || '/'}${url.search || ''}`;
      } catch {
        return link;
      }
    }),
    controls: (scan.controls ?? []).slice(0, MAX_CONTROLS_PER_PAGE).map((control) => ({
      label: control.label,
      selector: control.selector,
      tag: control.tag,
      role: control.role,
      type: control.type,
      href: control.href,
      testId: control.testId,
      disabled: control.disabled,
    })),
    forms: (scan.forms ?? []).map((form) => ({
      selector: form.selector,
      action: form.action,
      fields: form.fields.map((field) => ({
        name: field.name,
        type: field.type,
        label: field.label,
        placeholder: field.placeholder,
        required: field.required,
        selector: field.selector,
      })),
      submitSelectors: form.submitSelectors,
    })),
  }));

  const observedSelectors = new Set<string>();
  for (const scan of scans) {
    for (const control of scan.controls ?? []) observedSelectors.add(control.selector);
  }

  const userMessage = trimPayload(JSON.stringify({
    baseUrl: options.baseUrl,
    instructions: options.instructions ?? 'Discover all meaningful routes and user journeys before test generation.',
    remainingPages: options.remainingPages ?? 0,
    pages,
    OBSERVED_CONTROL_SELECTORS: Array.from(observedSelectors),
  }));

  const systemPrompt = `You are an AI route-discovery advisor for a browser test generator.
Use the observed DOM, controls, links, headings, form fields, and labels to identify additional same-origin routes and route-changing controls that should be scanned before test generation.

Return only JSON:
{
  "routes": string[],
  "selectors": string[],
  "coverageGoals": string[],
  "rationale": string[]
}

Rules:
- routes must be same-origin absolute URLs or root-relative paths.
- You may infer common SPA paths from observed navigation labels, page titles, test IDs, data-route-like labels, and authenticated app-shell text.
- selectors must be copied exactly from OBSERVED_CONTROL_SELECTORS; never invent selectors.
- Prefer navigation tabs, menu items, sidebar links, account/settings/profile items, dashboards, lists, detail pages, forms, and create/edit flows.
- Do not suggest destructive, logout, payment, upload, submit, sign-in, sign-up, or modal-close controls.
- Do not include external URLs, assets, anchors, mailto/tel, or duplicate routes.
- If a page is only a login form and no credentials are available in the scan, report coverageGoals explaining that authenticated routes require credentials rather than guessing private pages.`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PASS_TIMEOUT_MS);
  try {
    const completion = await openai.chat.completions.create(
      {
        model: MODEL,
        temperature: 0.1,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
      },
      { signal: controller.signal },
    );
    const raw = completion.choices[0]?.message?.content ?? '{}';
    const parsed = JSON.parse(raw);
    return {
      routes: normalizeRoutes(parsed.routes, options.baseUrl),
      selectors: normalizeSelectors(parsed.selectors, observedSelectors),
      coverageGoals: Array.isArray(parsed.coverageGoals) ? parsed.coverageGoals.filter((v: unknown) => typeof v === 'string').slice(0, 20) : [],
      rationale: Array.isArray(parsed.rationale) ? parsed.rationale.filter((v: unknown) => typeof v === 'string').slice(0, 20) : [],
    };
  } catch (err) {
    console.warn('[url-builder-route-ai] route advisor failed:',
      err instanceof Error ? err.message : String(err));
    return { routes: [], selectors: [], coverageGoals: [], rationale: [] };
  } finally {
    clearTimeout(timer);
  }
}
