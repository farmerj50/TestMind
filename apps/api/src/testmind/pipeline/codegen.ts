// apps/api/src/testmind/pipeline/codegen.ts
import type { TestPlan } from "../core/plan.js";
import { emitSpecFile } from "../adapters/playwright-ts/generator.js";
import fs from "node:fs/promises";
import path from "node:path";

/** Map any incoming TestCase shape to the emitter's shape */
function normalizeCases(casesAny: any[]): any[] {
  return casesAny.map((c, idx) => {
    const name = c.name ?? c.title ?? `case-${idx}`;
    const group = c.group ?? (c.page ? { page: c.page } : undefined);

    const steps = (c.steps ?? [])
      .map((s: any) => {
        // passthrough
        if (
          s.kind === "goto" ||
          s.kind === "expect-text" ||
          s.kind === "expect-visible" ||
          s.kind === "fill" ||
          s.kind === "click" ||
          s.kind === "upload"
        ) {
          return s;
        }

        // convert older shapes
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
            return {
              kind: "fill",
              selector: `label=${s.value}`,
              value: s.text ?? "",
            };
          if (s.by === "selector")
            return { kind: "fill", selector: s.value, value: s.text ?? "" };
        }

        // drop unsupported legacy kinds
        return null;
      })
      .filter(Boolean);

    return { id: c.id ?? `id-${idx}`, name, group, steps };
  });
}

/** Group by page (first goto path or group.page) */
function groupByPageCompat(cases: any[]) {
  const map = new Map<string, any[]>();
  for (const tc of cases) {
    let key = tc.group?.page;
    if (!key) {
      const firstGoto = tc.steps?.find((s: any) => s.kind === "goto");
      if (firstGoto?.url) {
        try {
          key = new URL(firstGoto.url).pathname || "/";
        } catch {
          key = "misc";
        }
      } else {
        key = "misc";
      }
    }
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(tc);
  }
  return map;
}

/** Write Playwright specs from an already-built TestPlan. */
export async function writeSpecsFromPlan(outDir: string, plan: TestPlan) {
  await fs.mkdir(outDir, { recursive: true });

  const raw = (plan as any).cases ?? (plan as any).testCases ?? [];
  const norm = normalizeCases(raw);
  const grouped = groupByPageCompat(norm);

  for (const [page, tcs] of grouped) {
    const base =
      page === "/" ? "home" : page.replace(/\//g, "_").replace(/^_/, "");
    const filePath = path.join(outDir, `${base}.spec.ts`);
    const content = emitSpecFile(page, tcs as any);
    await fs.writeFile(filePath, content, "utf8");
  }

  return { total: norm.length, pages: grouped.size, outDir };
}
