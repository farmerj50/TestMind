import type { TestPlan } from "../../core/plan.js";

// ------- Types mirrored from plan/pattern -------
type Step =
  | { kind: "goto"; url: string }
  | { kind: "expect-text"; text: string }
  | { kind: "fill"; selector: string; value: string }
  | { kind: "click"; selector: string }
  | { kind: "upload"; selector: string; path: string }
  | { kind: "expect-visible"; selector: string }; // legacy mapping support

type TestCase = {
  id: string;
  name: string;
  group?: { page?: string };
  steps: Step[];
};

// ------- Group cases by page (default "/") -------
export function groupByPage(cases: TestCase[]): Map<string, TestCase[]> {
  const m = new Map<string, TestCase[]>();
  for (const tc of cases ?? []) {
    const page = tc.group?.page || "/";
    const arr = m.get(page) ?? [];
    arr.push(tc);
    m.set(page, arr);
  }
  return m;
}

// ------- Emit a single test case -------
function emitTest(tc: TestCase): string {
  const body = tc.steps.map(emitStep).join("\n");
  // De-dupe test titles slightly to avoid Playwright warnings
  const safeName = tc.name.replace(/\s+/g, " ").trim();
  return `
test(${JSON.stringify(safeName)}, async ({ page }) => {
${body}
});`.trim();
}

// ------- Map each step -> Playwright code -------
function emitStep(s: Step): string {
  switch (s.kind) {
    case "goto":
      return `  await page.goto(${JSON.stringify(s.url)});`;
    case "expect-text":
      return `  await expect(page.getByText(${JSON.stringify(s.text)})).toBeVisible();`;
    case "expect-visible": // keep legacy mapping working
      return `  await expect(page.locator(${JSON.stringify(s.selector)})).toBeVisible();`;
    case "fill":
      return `  await page.locator(${JSON.stringify(s.selector)}).fill(${JSON.stringify(s.value)});`;
    case "click":
      return `  await page.locator(${JSON.stringify(s.selector)}).click();`;
    case "upload":
      return `  await page.setInputFiles(${JSON.stringify(s.selector)}, ${JSON.stringify(s.path)});`;
    default:
      return `  // TODO: unsupported step ${JSON.stringify((s as any).kind)}`;
  }
}

// ------- Emit a whole spec file for one page with ALL its cases -------
export function emitSpecFile(pagePath: string, tcs: TestCase[]): string {
  const tests = (tcs ?? []).map(emitTest).join("\n\n");
  const banner = `// Auto-generated for page ${pagePath} — ${tcs?.length ?? 0} test(s)`;
  return `
import { test, expect } from '@playwright/test';

${banner}

${tests}
`.trimStart();
}

// ------- Adapter-style renderer (if you still call adapter.render(plan)) -------
export const playwrightTSAdapter = {
  id: "playwright-ts",
  render(plan: TestPlan) {
    const grouped = groupByPage((plan as any).cases ?? []);
    const files: { path: string; content: string }[] = [];
    for (const [page, tcs] of grouped) {
      const base = page === "/" ? "home" : page.replace(/\//g, "_").replace(/^_/, "");
      const content = emitSpecFile(page, tcs);
      files.push({ path: `${base}.spec.ts`, content });
    }
    return files;
  },
  manifest(plan: TestPlan) {
    return {
      pages: Array.from(groupByPage((plan as any).cases ?? []).keys()),
      count: (plan as any).cases?.length ?? 0,
    };
  },
};
