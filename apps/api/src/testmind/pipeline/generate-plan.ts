import type { TestPlan } from "../core/plan.js";
import * as P from "../core/pattern.js";

type Persona = "manual" | "sdet" | "automation";
type PatternInput = any;

function safePathname(u: string, base?: string): string {
  try { return base ? new URL(u, base).pathname : new URL(u).pathname; }
  catch { return typeof u === "string" && u.startsWith("/") ? u : "/"; }
}
function absUrl(route: string, base?: string): string {
  try { return base ? new URL(route, base).toString() : new URL(route).toString(); }
  catch { return typeof route === "string" && route.startsWith("/") && base ? new URL(route, base).toString() : (route || "/"); }
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
  for (const fromPath of paths) {
    const fromUrl = pathToUrl.get(fromPath)!;
    const others = paths.filter((p) => p !== fromPath).slice(0, 3);
    for (const toPath of others) {
      const toUrl = pathToUrl.get(toPath)!;
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
  // Prefer real persona bundles if wired
  const bundles = (P as any).personaBundles as
    | Record<string, ((i: PatternInput) => any[])[]>
    | undefined;

  let cases: any[] = [];
  if (bundles && Array.isArray(bundles[persona])) {
    const fns = bundles[persona];
    cases = fns.flatMap((fn) => fn(input));
  } else {
    cases = fallbackCases(input); // upgraded fallback
  }

  return {
    baseUrl: input?.env?.baseUrl ?? "/",
    cases,
    meta: { persona, count: cases.length, generatedAt: new Date().toISOString() },
  };
}

export default generatePlan;
