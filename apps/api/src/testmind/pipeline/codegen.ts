import type { TestPlan } from "../core/plan.js";
import { emitSpecFile } from "../adapters/playwright-ts/generator.js";
import { cucumberJSAdapter } from "../adapters/cucumber-js/generator.js";
import { cypressJSAdapter } from "../adapters/cypress-js/generator.js";
import { appiumJSAdapter } from "../adapters/appium-js/generator.js";
import { xctestAdapter } from "../adapters/xctest/generator.js";
import fs from "node:fs/promises";
import path from "node:path";
// at top (under imports)
const toPath = (u: string): string => {
  try {
    const { pathname, search, hash } = new URL(u);
    return (pathname || "/") + (search || "") + (hash || "");
  } catch {
    return typeof u === "string" && u.startsWith("/") ? u : "/";
  }
};



/** Map any incoming TestCase shape to the emitter's expected shape */
function normalizeCases(casesAny: any[]): any[] {
  return casesAny.map((c, idx) => {
    const name = c.name ?? c.title ?? `case-${idx}`;
    const group = c.group ?? (c.page ? { page: c.page } : undefined);

    const steps = (c.steps ?? [])
      .map((s: any) => {
        if (s.kind === "goto") {
          return { kind: "goto", url: toPath(s.url) };
        }
        if (
          s.kind === "goto" ||
          s.kind === "expect-text" ||
          s.kind === "expect-visible" ||
          s.kind === "fill" ||
          s.kind === "click" ||
          s.kind === "upload"
        ) return s;

        // legacy → new
        if (s.kind === "expectVisible") {
          if (s.by === "text") return { kind: "expect-text", text: s.value };
          return { kind: "expect-visible", selector: s.value };
        }
        if (s.kind === "click") {
          if (s.by === "text" || s.by === "label")
            return { kind: "click", selector: `text=${s.value}` };
          return { kind: "click", selector: s.selector ?? s.value };
        }
        if (s.kind === "fill") {
          if (s.selector && s.value !== undefined)
            return { kind: "fill", selector: s.selector, value: s.value };
          if (s.by === "label")
            return { kind: "fill", selector: `label=${s.value}`, value: s.text ?? "" };
          if (s.by === "selector")
            return { kind: "fill", selector: s.value, value: s.text ?? "" };
        }
        return null;
      })
      .filter(Boolean);

    return { id: c.id ?? `id-${idx}`, name, group, steps };
  });
}

/** Group by page (group.page or first goto pathname) */
function groupByPageCompat(cases: any[]) {
  const map = new Map<string, any[]>();
  for (const tc of cases) {
    let key = tc.group?.page;
    if (!key) {
      const firstGoto = tc.steps?.find((s: any) => s.kind === "goto");
      if (firstGoto?.url) {
        try { key = new URL(firstGoto.url).pathname || "/"; }
        catch { key = "misc"; }
      } else key = "misc";
    }
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(tc);
  }
  return map;
}

/** ✅ Named export used by synthesize.ts and service.ts */
/** ✅ Named export used by synthesize.ts and service.ts */
export async function writeSpecsFromPlan(outDir: string, plan: TestPlan, adapterId = "playwright-ts") {
  console.log("[tm-pipeline-codegen] using adapter ->", adapterId, "at", outDir);

  const normOut = outDir.replace(/\\/g, "/");
  if (/(^|\/)(default|tests)(\/|$)/.test(normOut)) {
    throw new Error(`outDir must be the adapter root (got ${outDir})`);
  }

  await fs.mkdir(outDir, { recursive: true });

  const raw = (plan as any).cases ?? (plan as any).testCases ?? [];
  const norm = normalizeCases(raw);

  if (adapterId === "cucumber-js") {
    const files = cucumberJSAdapter.render({ ...(plan as any), cases: norm } as any);
    let logged = false;
    for (const f of files) {
      const dest = path.join(outDir, f.path);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, f.content, "utf8");
      if (!logged) { console.log("[tm-pipeline-codegen] wrote:", dest); logged = true; }
    }
    return { total: norm.length, pages: cucumberJSAdapter.manifest(plan).pages.length, outDir };
  }

  if (adapterId === "cypress-js") {
    const files = cypressJSAdapter.render({ ...(plan as any), cases: norm } as any);
    let logged = false;
    for (const f of files) {
      const dest = path.join(outDir, f.path);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, f.content, "utf8");
      if (!logged) { console.log("[tm-pipeline-codegen] wrote:", dest); logged = true; }
    }
    return { total: norm.length, pages: cypressJSAdapter.manifest(plan).pages.length, outDir };
  }

  if (adapterId === "appium-js") {
    const files = appiumJSAdapter.render({ ...(plan as any), cases: norm } as any);
    let logged = false;
    for (const f of files) {
      const dest = path.join(outDir, f.path);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, f.content, "utf8");
      if (!logged) { console.log("[tm-pipeline-codegen] wrote:", dest); logged = true; }
    }
    return { total: norm.length, pages: appiumJSAdapter.manifest(plan).pages.length, outDir };
  }

  if (adapterId === "xctest") {
    const files = xctestAdapter.render(plan);
    for (const f of files) {
      const dest = path.join(outDir, f.path);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, f.content, "utf8");
    }
    return { total: norm.length, pages: 0, outDir };
  }

  // Default: Playwright TS
  const grouped = groupByPageCompat(norm);

  let logged = false;
  for (const [page, tcs] of grouped) {
    const base = page === "/"
      ? "home"
      : page.replace(/\//g, "_").replace(/^_/, "");
    const filePath = path.join(outDir, `${base}.spec.ts`);
    const content = emitSpecFile(page, tcs as any);
    await fs.writeFile(filePath, content, "utf8");
    if (!logged) { console.log("[tm-pipeline-codegen] wrote:", filePath); logged = true; }
  }

  return { total: norm.length, pages: grouped.size, outDir };
}
