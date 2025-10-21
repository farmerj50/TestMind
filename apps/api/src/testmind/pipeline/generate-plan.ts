import type { TestPlan } from "../core/plan.js";
import * as P from "../core/pattern.js";

type Persona = "manual" | "sdet" | "automation";
type PatternInput = any;
const NAV_MAX = Number(process.env.TM_NAV_PER_PAGE || 20);

function guessValue(name?: string, type?: string): string {
  const n = (name ?? "").toLowerCase();
  if (type === "email" || n.includes("email")) return "qa+auto@example.com";
  if (type === "password") return "P@ssw0rd1!";
  if (type === "tel" || n.includes("phone")) return "4045551234";
  if (n.includes("zip")) return "30301";
  if (n.includes("name")) return "QA Auto";
  if (type === "number") return "42";
  return "Test value";
}

function safePathname(u: string, base?: string): string {
  try { return base ? new URL(u, base).pathname : new URL(u).pathname; }
  catch { return typeof u === "string" && u.startsWith("/") ? u : "/"; }
}
function absUrl(route: string, base?: string): string {
  try { return base ? new URL(route, base).toString() : new URL(route).toString(); }
  catch { return typeof route === "string" && route.startsWith("/") && base ? new URL(route, base).toString() : (route || "/"); }
}
function casesFromScans(input: any): any[] {
  const scans: any[] = Array.isArray(input?.discovered?.scans) ? input.discovered.scans : [];
  if (!scans.length) return [];

  const base = input?.env?.baseUrl;
  const out: any[] = [];
  const seen = new Set<string>();
  const push = (tc: any) => { if (!seen.has(tc.id)) { seen.add(tc.id); out.push(tc); } };

  const safePath = (u: string) => {
    try { return new URL(u, base).pathname || "/"; } catch { return "/"; }
  };

  for (const scan of scans) {
    const pagePath = safePath(scan.url);

    // 1) Smoke
    push({
      id: `smoke:${scan.url}`,
      name: `Page loads: ${pagePath}`,
      group: { page: pagePath },
      steps: [
        { kind: "goto", url: scan.url },
        { kind: "expect-text", text: scan.title || "Sign" },
      ],
    });

    // 2) Happy-path form submit with fills (if fields + a submit/button)
    if ((scan.fields?.length || 0) > 0 && (scan.buttons?.length || 0) > 0) {
      const fills = scan.fields.map((f: any) => ({
        kind: "fill",
        selector: `[name='${f.name}'], #${f.name}`,
        value: guessValue(f.name, f.type),
      }));
      push({
        id: `form-happy:${scan.url}`,
        name: `Form submits – ${pagePath}`,
        group: { page: pagePath },
        steps: [
          { kind: "goto", url: scan.url },
          ...fills,
          { kind: "click", selector: "button[type='submit'], input[type='submit']" },
          { kind: "expect-text", text: "success" },
        ],
      });
    }

    // 3) Required validation (if any field required and a submit)
    if ((scan.fields || []).some((f: any) => f?.required) && (scan.buttons?.length || 0) > 0) {
      push({
        id: `form-validation:${scan.url}`,
        name: `Validation blocks empty submission – ${pagePath}`,
        group: { page: pagePath },
        steps: [
          { kind: "goto", url: scan.url },
          { kind: "click", selector: "button[type='submit'], input[type='submit']" },
          { kind: "expect-text", text: "required" },
        ],
      });
    }

    // 4) File upload (if any file inputs)
    if ((scan.fileInputs?.length || 0) > 0) {
      push({
        id: `file-upload:${scan.url}`,
        name: `Upload document – ${pagePath}`,
        group: { page: pagePath },
        steps: [
          { kind: "goto", url: scan.url },
          { kind: "upload", selector: `[name='${scan.fileInputs[0]}']`, path: "tests/assets/sample.pdf" },
          { kind: "click", selector: "button[type='submit'], input[type='submit']" },
          { kind: "expect-text", text: "uploaded" },
        ],
      });
    }

    // 5) Navigation via links found on THIS page
    // 5) Navigation via links found on THIS page
    const linkPaths: string[] = Array.from(
      new Set<string>(
        (scan.links || [])
          .map((l: string) => safePath(l))           // string
          .filter((p: string) => p && p !== pagePath) // string
      )
    ).slice(0, NAV_MAX);

    for (const toPath of linkPaths) {
      push({
        id: `nav:${scan.url}->${toPath}`,
        name: `Navigate ${pagePath} → ${toPath}`,
        group: { page: pagePath },
        steps: [
          { kind: "goto", url: scan.url },
          { kind: "goto", url: toPath }, // codegen normalizes to path
          { kind: "expect-text", text: (toPath.split("/").pop() || "Page") },
        ],
      });
    }

  }

  return out;
}

/** Build a richer plan when personaBundles aren’t available. */
function fallbackCases(input: PatternInput): any[] {
  const base = input?.env?.baseUrl;

  // 1) Gather & de-dupe page paths
  const rawRoutes: string[] = Array.isArray(input?.discovered?.routes)
    ? input.discovered.routes
    : [];
  const paths = Array.from(
    new Set(
      rawRoutes
        .map((r) => safePathname(r, base))
        .filter(Boolean)
    )
  );

  // Map path -> fully qualified URL we’ll navigate to
  const pathToUrl = new Map<string, string>();
  for (const p of paths) pathToUrl.set(p, absUrl(p, base));

  // Forms keyed by route/page hint (best effort)
  const forms: any[] = Array.isArray(input?.discovered?.forms)
    ? input.discovered.forms
    : [];
  const formsByPath = new Map<string, any[]>();
  for (const f of forms) {
    const hint = safePathname(f?.routeHint ?? "/", base);
    const arr = formsByPath.get(hint) ?? [];
    arr.push(f);
    formsByPath.set(hint, arr);
  }

  const cases: any[] = [];
  const seenIds = new Set<string>();

  const push = (tc: any) => {
    if (!seenIds.has(tc.id)) { seenIds.add(tc.id); cases.push(tc); }
  };

  // 2) Per-page smoke + page-local form tests
  for (const pagePath of paths) {
    const pageUrl = pathToUrl.get(pagePath)!;

    // Smoke
    push({
      id: `smoke:${pageUrl}`,
      name: `Page loads: ${pagePath}`,
      group: { page: pagePath },
      steps: [
        { kind: "goto", url: pageUrl },
        { kind: "expect-text", text: "Sign" }, // generic visible text
      ],
    });

    // Forms on this page
    const locals = formsByPath.get(pagePath) ?? [];
    for (const f of locals) {
      // Validation (required-only)
      if (Array.isArray(f.fields) && f.fields.some((x: any) => x?.required)) {
        push({
          id: `form-validation:${pageUrl}:${f.selector ?? ""}`,
          name: `Validation blocks empty submission – ${pagePath}`,
          group: { page: pagePath },
          steps: [
            { kind: "goto", url: pageUrl },
            { kind: "click", selector: "button[type='submit'], input[type='submit']" },
            { kind: "expect-text", text: "required" },
          ],
        });
      }

      // Happy submit (no fills in fallback because selectors/values may be unknown)
      push({
        id: `form-submit:${pageUrl}:${f.selector ?? ""}`,
        name: `Form submits – ${pagePath}`,
        group: { page: pagePath },
        steps: [
          { kind: "goto", url: pageUrl },
          { kind: "click", selector: "button[type='submit'], input[type='submit']" },
          { kind: "expect-text", text: "success" },
        ],
      });
    }
  }

  // 3) Simple navigation cases: from each page to up to 3 other distinct pages
  // 3) Navigation cases per page — prefer real links seen on that page
  const scans: any[] = Array.isArray(input?.discovered?.scans) ? input.discovered.scans : [];
  const scanByPath = new Map<string, any>();
  for (const s of scans) {
    const p = safePathname(s?.url, base);
    if (p) scanByPath.set(p, s);
  }

  for (const fromPath of paths) {
    const fromUrl = pathToUrl.get(fromPath)!;

    // Prefer links actually seen on this page; otherwise fall back to other known paths
    const fromScan = scanByPath.get(fromPath);
    const linkTargets: string[] = Array.isArray(fromScan?.links) && fromScan.links.length
      ? fromScan.links
        .map((l: string) => safePathname(l, base))
        .filter((p: string) => p && p !== fromPath)
      : paths.filter((p) => p !== fromPath);

    for (const toPath of Array.from(new Set(linkTargets)).slice(0, NAV_MAX)) {
      const toUrl = pathToUrl.get(toPath) ?? absUrl(toPath, base);
      push({
        id: `nav:${fromUrl}->${toUrl}`,
        name: `Navigate ${fromPath} → ${toPath}`,
        group: { page: fromPath },
        steps: [
          { kind: "goto", url: fromUrl },
          { kind: "goto", url: toUrl },
          { kind: "expect-text", text: (toPath.split("/").pop() || "Page") },
        ],
      });
    }
  }


  return cases;
}

export function generatePlan(input: PatternInput, persona: Persona = "sdet"): TestPlan {
  const bundles = (P as any).personaBundles as Record<string, ((i: PatternInput) => any[])[]> | undefined;

  let cases: any[] = [];
  if (bundles && Array.isArray(bundles[persona])) {
    cases = bundles[persona].flatMap((fn) => fn(input));
  } else {
    // NEW: prefer scans (rich), otherwise fall back to routes
    cases = casesFromScans(input);
    if (cases.length === 0) {
      cases = fallbackCases(input);
    }
  }

  return {
    baseUrl: input?.env?.baseUrl ?? "/",
    cases,
    meta: { persona, count: cases.length, generatedAt: new Date().toISOString() },
  };
}

export default generatePlan;
