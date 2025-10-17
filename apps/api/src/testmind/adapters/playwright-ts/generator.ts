// apps/api/src/testmind/adapters/playwright-ts/generator.ts
import type { TestPlan, TestCase } from "../../core/plan.js";
import type { TestAdapter } from "../../core/adapter.js";

const slug = (s: string) =>
  String(s).replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase();

const pageKeyFromCase = (tc: TestCase): string => {
  // prefer explicit grouping if a pattern supplied it
  const page = (tc as any)?.group?.page; // group is optional
  if (page) return page;

  // infer from the *last* goto (not the first)
  const lastGoto = [...tc.steps].reverse().find((s: any) => s.kind === "goto") as any;
  if (lastGoto?.url) {
    try {
      return new URL(lastGoto.url).pathname || "/";
    } catch {
      return "misc";
    }
  }
  return "misc";
};

const toPWLine = (step: any): string[] => {
  const out: string[] = [];
  switch (step.kind) {
    case "goto":
      out.push(`await page.goto(${JSON.stringify(step.url)});`);
      break;

    case "click":
      if (step.by === "text") out.push(`await page.getByText(${JSON.stringify(step.value)}).click();`);
      else if (step.by === "role") out.push(`await page.getByRole(${JSON.stringify(step.value)}).click();`);
      else if (step.by === "label") out.push(`await page.getByLabel(${JSON.stringify(step.value)}).click();`);
      else out.push(`await page.locator(${JSON.stringify(step.value)}).click();`);
      break;

    case "fill":
      // support both old 'selector' and new 'by/value/text' shapes
      if (step.by) {
        if (step.by === "label") {
          out.push(`await page.getByLabel(${JSON.stringify(step.value)}).fill(${JSON.stringify(step.text ?? step.value ?? "")});`);
        } else {
          out.push(`await page.locator(${JSON.stringify(step.value)}).fill(${JSON.stringify(step.text ?? step.value ?? "")});`);
        }
      } else {
        out.push(`await page.locator(${JSON.stringify(step.selector)}).fill(${JSON.stringify(step.value ?? "")});`);
      }
      break;

    case "expectVisible":
      if (step.by === "text") out.push(`await expect(page.getByText(${JSON.stringify(step.value)})).toBeVisible();`);
      else out.push(`await expect(page.locator(${JSON.stringify(step.value)})).toBeVisible();`);
      break;

    case "apiCall":
      out.push(`// apiCall: ${step.method} ${step.path} -> ${step.expectStatus}`);
      break;

    case "waitForIdle":
      out.push(`// waitForIdle`);
      break;

    case "assert":
      out.push(`// assert: ${step.expr}${step.message ? " // " + step.message : ""}`);
      break;

    default:
      out.push(`// TODO unsupported step: ${JSON.stringify(step)}`);
  }
  return out;
};

function renderCase(tc: TestCase): string {
  const lines: string[] = [];
  lines.push(`test(${JSON.stringify(tc.title)}, async ({ page }) => {`);
  tc.steps.forEach((st) => toPWLine(st).forEach((l) => lines.push(`  ${l}`)));
  lines.push(`});`);
  return lines.join("\n");
}

function renderPageSpec(pageKey: string, cases: TestCase[]): string {
  const header = [
    `import { test, expect } from '@playwright/test';`,
    ``,
    `// Page: ${pageKey} — ${cases.length} tests`,
  ];
  const body = cases.map(renderCase).join("\n\n");
  return [...header, body, ""].join("\n");
}

export const playwrightTSAdapter: TestAdapter = {
  id: "playwright-ts",
  displayName: "Playwright (TS)",

  render(plan: TestPlan) {
    // group by page
    const buckets = new Map<string, TestCase[]>();

    // read from either `cases` or `testCases`
    const all: TestCase[] = ((plan as any).cases ?? (plan as any).testCases ?? []) as TestCase[];

    for (const tc of all) {
      const key = pageKeyFromCase(tc);
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key)!.push(tc);
    }

    // files array
    const files: { path: string; content: string }[] = [];

    // package.json
    files.push({
      path: `package.json`,
      content: JSON.stringify(
        {
          name: "tm-playwright-ts",
          private: true,
          type: "module",
          scripts: { "test:pw": "npx playwright test -c playwright.config.ts" },
          devDependencies: { "@playwright/test": "^1.47.2" },
        },
        null,
        2
      ),
    });

    // config with baseURL from env or plan (+ node types ref to quiet 'process' typing)
    const baseURL = (plan as any).baseUrl || (plan as any).meta?.baseUrl || "http://localhost:3000";
    files.push({
      path: `playwright.config.ts`,
      content: `
/// <reference types="node" />
import type { PlaywrightTestConfig } from '@playwright/test';
const config: PlaywrightTestConfig = {
  use: {
    baseURL: process.env.TM_BASE_URL || ${JSON.stringify(baseURL)},
  },
};
export default config;
`.trimStart(),
    });

    // one spec per page
    for (const [page, list] of buckets) {
      const fname = `tests/${slug(page || "root")}.spec.ts`;
      files.push({ path: fname, content: renderPageSpec(page, list) });
    }

    // optional simple smoke file if nothing else
    if (!buckets.size) {
      files.push({
        path: `tests/smoke.spec.ts`,
        content: `
import { test, expect } from '@playwright/test';
test('Smoke / loads', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('Sign')).toBeVisible();
});
`.trimStart(),
      });
    }

    return files;
  },

  manifest(plan: TestPlan) {
    const count = ((plan as any).cases ?? (plan as any).testCases ?? []).length;
    return { adapter: "playwright-ts", count, baseUrl: (plan as any).baseUrl };
  },
};
