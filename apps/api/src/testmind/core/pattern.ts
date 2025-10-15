// apps/api/src/testmind/core/patterns.ts
import type {
    TestCase,
    Component,
    Requirement,
    Discovery,
    Env,
} from './plan.js';


/**
 * Personas we support when selecting which patterns to apply.
 */
export type Persona = 'manual' | 'sdet' | 'automation';

/**
 * Input every pattern receives.
 */
export type PatternInput = {
    component: Component;
    requirement?: Requirement;
    risks: { likelihood: number; impact: number };
    discovered: Discovery;
    env: Env;
};

/**
 * A pattern takes the discovered info + context and returns concrete test cases.
 */
export type Pattern = (i: PatternInput) => TestCase[];

/* ------------------------ small utilities ------------------------ */


const baseUrlOf = (env: Env): string => env.baseUrl ?? '/';

/* ------------------------ pattern families ------------------------ */

/**
 * Manual smoke: visit up to 5 discovered routes and assert a couple of key texts.
 */
export const manualSmoke: Pattern = (i) => {
    const base = baseUrlOf(i.env);
     const routes = seedIfThin(i.discovered.routes);

    return routes.map((r: string, idx: number): TestCase => ({
        id: `smoke_${idx}`,
        title: `Smoke ${r}`,
        steps: [
            { kind: 'goto' as const, url: new URL(r, base).toString() },
            { kind: 'expectVisible' as const, by: 'text', value: 'Sign in' },
            { kind: 'expectVisible' as const, by: 'text', value: 'Dashboard' },
        ],
    }));
};

/**
 * Manual negative: for a few discovered forms, submit with required fields empty
 * and expect a validation message.
 */
export const manualNegative: Pattern = (i) => {
    const base = baseUrlOf(i.env);
    const out: TestCase[] = [];

    // We don't assume a strict form schema; we read what scanner discovered.
    const forms = ((i.discovered as any).forms as any[] | undefined) ?? [];

    for (const form of forms) {
        const f = form as any;
        const url = new URL(f.routeHint ?? '/', base).toString();
        const fields: any[] = Array.isArray(f.fields) ? f.fields : [];

        out.push({
            id: `neg_required_${f.selector ?? 'form'}`,
            title: `Negative required – ${f.selector ?? 'form'}`,
            steps: [
                { kind: 'goto' as const, url },
                ...fields.map((fld: any) => ({
                    kind: 'fill' as const,
                    by: 'selector' as const,
                    value: `[name="${String(fld.name)}"]`,
                    text: '',
                })),

                {
                    kind: 'click' as const,
                    by: 'selector',
                    value: (f.submitSelector as string) ?? 'button[type="submit"]',
                },
                { kind: 'expectVisible' as const, by: 'text', value: 'required' },
            ],
        });
    }

    return out;
};

/**
 * SDET boundary: fill form fields with oversized inputs to probe validators.
 */
export const sdetBoundary: Pattern = (i) => {
    const base = baseUrlOf(i.env);
    const out: TestCase[] = [];

    const forms = ((i.discovered as any).forms as any[] | undefined) ?? [];

    for (const form of forms) {
        const f = form as any;
        const url = new URL(f.routeHint ?? '/', base).toString();
        const fields: any[] = Array.isArray(f.fields) ? f.fields : [];

        out.push({
            id: `bounds_${f.selector ?? 'form'}`,
            title: `Boundary values – ${f.selector ?? 'form'}`,
            steps: [
                { kind: 'goto' as const, url },
                ...fields.map((fld: any) => ({
                    kind: 'fill' as const,
                    by: 'selector' as const,
                    value: `[name="${String(fld.name)}"]`,
                    text: 'A'.repeat(256),
                })),

                {
                    kind: 'click' as const,
                    by: 'selector',
                    value: (f.submitSelector as string) ?? 'button[type="submit"]',
                },
            ],
        });
    }

    return out;
};
// ---------- helpers ----------
const seedIfThin = (routes?: string[]): string[] => {
  const base = routes ?? [];
  if (base.length >= 20) return base; // if scanner found enough, use it
  const seeds = [
    '/', '/pricing', '/contact', '/signin', '/signup',
    '/dashboard', '/documents', '/document-builder'
  ];
  return Array.from(new Set([...base, ...seeds]));
};


/**
 * SDET state flows: simple multi-step route checks to cover basic navigation.
 */
export const sdetState: Pattern = (i) => {
    const base = baseUrlOf(i.env);
    const routes = seedIfThin(i.discovered.routes);

     return routes.map((r: string, idx: number): TestCase => ({
        id: `flow_${idx}`,
        title: `Flow ${r}`,
        steps: [
            { kind: 'goto' as const, url: new URL(r, base).toString() },
            { kind: 'click' as const, by: 'text', value: 'Sign in' },
            { kind: 'expectVisible' as const, by: 'text', value: 'Dashboard' },
        ],
    }));
};
// ---------- helpers ----------
const slug = (s: string) => String(s).replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase();
const pageOf = (url: string) => {
  try { const u = new URL(url, "http://x"); return u.pathname || "/"; } catch { return "/"; }
};

// ---------- ROUTE SMOKE (expand to 50) ----------
export const routeSmokeWide: Pattern = (i) => {
  const base = i.env.baseUrl ?? "/";
  const routes = seedIfThin(i.discovered.routes);
  return routes.map((r, idx) => {
    const url = new URL(r, base).toString();
    return {
      id: `route_smoke_${idx}_${slug(r)}`,
      title: `Route smoke: ${r}`,
      group: { page: r, feature: "route", type: "smoke", priority: "P1" },
      tags: ["route","smoke"],
      steps: [
        { kind: "goto", url },
        { kind: "expectVisible", by: "text", value: "Sign" }, // generic “Sign” (Sign in/up) works across most pages
      ],
    };
  });
};

// ---------- NAVBAR (top level links from common texts) ----------
export const navbarTraverse: Pattern = (i) => {
  const base = i.env.baseUrl ?? "/";
  const start = (i.discovered.routes?.includes("/")) ? "/" : (i.discovered.routes?.[0] ?? "/");
  const texts = ["Home","Pricing","Contact","Sign in","Sign up","Get started","Dashboard"];
  return texts.map((t, idx) => ({
    id: `nav_${idx}_${slug(t)}`,
    title: `Navbar link: ${t}`,
    group: { page: start, feature: "navbar", type: "nav", priority: "P2" },
    tags: ["nav","cta"],
    steps: [
      { kind: "goto", url: new URL(start, base).toString() },
      { kind: "click", by: "text", value: t },
      { kind: "expectVisible", by: "text", value: t.split(" ")[0] },
    ],
  }));
};

// ---------- LINK CHECKER (page-level) ----------
export const pageLinksProbe: Pattern = (i) => {
  const base = i.env.baseUrl ?? "/";
  const routes = seedIfThin(i.discovered.routes);
  // Click up to 10 obvious links per page
  const candidates = ["Sign in","Sign up","Pricing","Contact","Learn","Docs","Dashboard","Choose plan","Start"];
      return routes.flatMap((r, ri) =>
        candidates.map((txt, ci) => ({
      id: `links_${ri}_${ci}_${slug(r)}_${slug(txt)}`,
      title: `Links on ${r}: ${txt}`,
      group: { page: r, feature: "links", type: "nav", priority: "P2" },
      tags: ["links","nav"],
      steps: [
        { kind: "goto", url: new URL(r, base).toString() },
        { kind: "click", by: "text", value: txt },
        { kind: "expectVisible", by: "text", value: txt.split(" ")[0] },
      ],
    }))
  );
};

// ---------- FORM HAPPY (fill all) ----------
export const formHappy: Pattern = (i) => {
  const base = i.env.baseUrl ?? "/";
  const forms = ((i.discovered as any).forms ?? []);
  return forms.map((f: any, idx: number) => {
    const url = new URL(f.routeHint ?? "/", base).toString();
    const fields: any[] = Array.isArray(f.fields) ? f.fields : [];
    return {
      id: `form_happy_${idx}_${slug(f.selector ?? "form")}`,
      title: `Form happy: ${f.selector ?? "form"}`,
      group: { page: pageOf(url), feature: "forms", type: "happy", priority: "P0" },
      tags: ["form","happy"],
      steps: [
        { kind: "goto", url },
        ...fields.map((fld) => ({
          kind: "fill" as const,
          by: "selector" as const,
          value: `[name="${String(fld.name)}"]`,
          text: fld.required ? "ok" : "opt",
        })),
        { kind: "click", by: "selector", value: f.submitSelector ?? 'button[type="submit"]' },
        { kind: "expectVisible", by: "text", value: "success" },
      ],
    };
  });
};

// ---------- FORM NEGATIVE (required empty) ----------
export const formRequiredEmpty: Pattern = (i) => {
  const base = i.env.baseUrl ?? "/";
  const forms = ((i.discovered as any).forms ?? []);
  return forms.map((f: any, idx: number) => {
    const url = new URL(f.routeHint ?? "/", base).toString();
    const fields: any[] = Array.isArray(f.fields) ? f.fields : [];
    const req = fields.filter((x) => !!x?.required);
    return {
      id: `form_required_${idx}_${slug(f.selector ?? "form")}`,
      title: `Form required empty: ${f.selector ?? "form"}`,
      group: { page: pageOf(url), feature: "forms", type: "negative", priority: "P0" },
      tags: ["form","negative","required"],
      steps: [
        { kind: "goto", url },
        ...req.map((fld) => ({
          kind: "fill" as const,
          by: "selector" as const,
          value: `[name="${String(fld.name)}"]`,
          text: "",
        })),
        { kind: "click", by: "selector", value: f.submitSelector ?? 'button[type="submit"]' },
        { kind: "expectVisible", by: "text", value: "required" },
      ],
    };
  });
};

// ---------- FORM BOUNDARY (already fixed to use by/value/text) ----------
export const formBoundaryWide: Pattern = (i) => {
  const base = i.env.baseUrl ?? "/";
  const forms = ((i.discovered as any).forms ?? []);
  return forms.map((f: any, idx: number) => {
    const url = new URL(f.routeHint ?? "/", base).toString();
    const fields: any[] = Array.isArray(f.fields) ? f.fields : [];
    return {
      id: `form_boundary_${idx}_${slug(f.selector ?? "form")}`,
      title: `Form boundary: ${f.selector ?? "form"}`,
      group: { page: pageOf(url), feature: "forms", type: "boundary", priority: "P1" },
      tags: ["form","boundary"],
      steps: [
        { kind: "goto", url },
        ...fields.map((fld) => ({
          kind: "fill" as const,
          by: "selector" as const,
          value: `[name="${String(fld.name)}"]`,
          text: "A".repeat(256),
        })),
        { kind: "click", by: "selector", value: f.submitSelector ?? 'button[type="submit"]' },
      ],
    };
  });
};

// ---------- ERROR PAGES / 404 ----------
export const route404Probe: Pattern = (i) => {
  const base = i.env.baseUrl ?? "/";
  const samples = ["/def-not-found", "/missing/page", "/zzz/404"];
  return samples.map((r, idx) => ({
    id: `route_404_${idx}`,
    title: `404 page for ${r}`,
    group: { page: r, feature: "routing", type: "error", priority: "P2" },
    tags: ["404","routing"],
    steps: [
      { kind: "goto", url: new URL(r, base).toString() },
      { kind: "expectVisible", by: "text", value: "404" },
    ],
  }));
};

/* Stubs that you can flesh out later */
export const automationA11y: Pattern = () => [];
export const automationPerf: Pattern = () => [];
export const automationSecurity: Pattern = () => [];
// === add below your other pattern defs, above personaBundles ===

// 1) Auth-gate checks for protected routes
export const sdetAuthGate: Pattern = (i) => {
  const base = i.env.baseUrl ?? "/";
  const gated = ["/dashboard", "/documents", "/document-builder"]; // adjust as needed
  return gated.map((path, idx) => ({
    id: `auth_gate_${idx}`,
    title: `Auth gate for ${path}`,
    group: { page: path, feature: "auth", type: "gate", priority: "P0" },
    tags: ["auth", "gate"],
    steps: [
      { kind: "goto", url: new URL(path, base).toString() },
      { kind: "expectVisible", by: "text", value: "Sign in" },
    ],
  }));
};


// 2) CTA / navbar clicks from key pages
export const manualCtas: Pattern = (i) => {
  const base = i.env.baseUrl ?? "/";
  const roots = ["/", "/pricing", "/contact"]; // adjust to your routes
  const ctas  = ["Sign up", "Get started", "Choose plan", "Contact", "Sign in"];

  return roots.flatMap((r, ri) =>
    ctas.map((t, ci) => ({
      id: `cta_${ri}_${ci}_${slug(r)}_${slug(t)}`,
      title: `CTA '${t}' from ${r}`,
      group: { page: r, feature: "navbar", type: "nav", priority: "P2" },
      tags: ["nav", "cta"],
      steps: [
        { kind: "goto", url: new URL(r, base).toString() },
        { kind: "click", by: "text", value: t },
        { kind: "expectVisible", by: "text", value: t.split(" ")[0] },
      ],
    }))
  );
};


/**
 * Which patterns we run for each persona.
 */
export const personaBundles: Record<Persona, Pattern[]> = {
  manual: [
    manualSmoke, manualNegative, manualCtas,
    routeSmokeWide, navbarTraverse, pageLinksProbe,
    formHappy, formRequiredEmpty, formBoundaryWide, route404Probe
  ],
  sdet: [
    manualSmoke, sdetBoundary, sdetState, manualNegative, sdetAuthGate, manualCtas,
    routeSmokeWide, navbarTraverse, pageLinksProbe,
    formHappy, formRequiredEmpty, formBoundaryWide, route404Probe
  ],
  automation: [
    manualSmoke, automationA11y, automationSecurity, manualNegative,
    routeSmokeWide, pageLinksProbe, route404Probe
  ],
};
