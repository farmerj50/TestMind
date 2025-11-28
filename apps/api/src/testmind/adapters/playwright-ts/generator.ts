import type { TestPlan } from "../../core/plan.js";

type Step =
  | { kind: "goto"; url: string }
  | { kind: "expect-text"; text: string }
  | { kind: "fill"; selector: string; value: string }
  | { kind: "click"; selector: string }
  | { kind: "upload"; selector: string; path: string }
  | { kind: "expect-visible"; selector: string }
  | { kind: "custom"; note?: string };

type TestCase = {
  id: string;
  name: string;
  group?: { page?: string };
  steps: Step[];
};

export function groupByPage(cases: TestCase[]): Map<string, TestCase[]> {
  const grouped = new Map<string, TestCase[]>();
  for (const tc of cases ?? []) {
    const page = tc.group?.page || "/";
    const arr = grouped.get(page) ?? [];
    arr.push(tc);
    grouped.set(page, arr);
  }
  return grouped;
}

function makeUniqTitleFactory() {
  const seen = new Map<string, number>();
  return (raw: string) => {
    const base = raw.replace(/\s+/g, " ").trim();
    const next = (seen.get(base) ?? 0) + 1;
    seen.set(base, next);
    return next === 1 ? base : `${base} [${next}]`;
  };
}

function describeStep(step: Step): string {
  switch (step.kind) {
    case "goto":
      return `Navigate to ${step.url}`;
    case "expect-text":
      return `Ensure text "${step.text}" is visible`;
    case "expect-visible":
      return `Ensure locator ${step.selector} is visible`;
    case "fill":
      return `Fill ${step.selector}`;
    case "click":
      return `Click ${step.selector}`;
    case "upload":
      return `Upload through ${step.selector}`;
    default:
      return `Run custom step`;
  }
}

function emitAction(step: Step): string {
  switch (step.kind) {
    case "goto":
      return `await page.goto(${JSON.stringify(step.url)});`;
    case "expect-text":
      return `await expect(page.getByText(${JSON.stringify(step.text)})).toBeVisible({ timeout: 10000 });`;
    case "expect-visible":
      if (!step.selector || typeof step.selector !== "string" || !step.selector.trim()) {
        return `// TODO: missing selector for expect-visible`;
      }
      return `{
  const locator = page.locator(${JSON.stringify(step.selector)});
  await locator.waitFor({ state: 'visible', timeout: 10000 });
  await expect(locator).toBeVisible({ timeout: 10000 });
}`;
    case "fill":
      if (!step.selector || typeof step.selector !== "string" || !step.selector.trim()) {
        return `// TODO: missing selector for fill`;
      }
      return `{
  const locator = page.locator(${JSON.stringify(step.selector)});
  await locator.waitFor({ state: 'visible', timeout: 10000 });
  await locator.fill(${JSON.stringify(step.value)});
}`;
    case "click":
      if (!step.selector || typeof step.selector !== "string" || !step.selector.trim()) {
        return `// TODO: missing selector for click`;
      }
      return `{
  const locator = page.locator(${JSON.stringify(step.selector)});
  await locator.waitFor({ state: 'visible', timeout: 10000 });
  await locator.click({ timeout: 10000 });
}`;
    case "upload":
      if (!step.selector || typeof step.selector !== "string" || !step.selector.trim()) {
        return `// TODO: missing selector for upload`;
      }
      return `{
  const locator = page.locator(${JSON.stringify(step.selector)});
  await locator.waitFor({ state: 'visible', timeout: 10000 });
  await locator.setInputFiles(${JSON.stringify(step.path)});
}`;
    default:
      return `// TODO: custom step`;
  }
}

function emitStep(step: Step, index: number): string {
  const title = `${index + 1}. ${describeStep(step)}`;
  const action = emitAction(step)
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
  return `  await test.step(${JSON.stringify(title)}, async () => {\n${action}\n  });`;
}

function emitAnnotations(pagePath: string, caseName: string): string {
  const entries = [
    { type: "parentSuite", description: "Testmind Generated Suite" },
    { type: "suite", description: pagePath },
    { type: "story", description: caseName },
    { type: "parameter", description: `page=${pagePath}` },
  ];
  return `  test.info().annotations.push(${entries
    .map((entry) => `{ type: ${JSON.stringify(entry.type)}, description: ${JSON.stringify(entry.description)} }`)
    .join(", ")});\n`;
}

function emitTest(tc: TestCase, uniqTitle: (s: string) => string, pagePath: string): string {
  const title = uniqTitle(tc.name);
  const hasGoto = tc.steps.some((s) => s.kind === "goto");
  const preNav = hasGoto
    ? ""
    : `  // Auto-nav added because no explicit goto step was provided\n  await page.goto(${JSON.stringify(pagePath)}, { waitUntil: 'networkidle' });\n`;

  const body =
    tc.steps.length > 0
      ? preNav + tc.steps.map((step, idx) => emitStep(step, idx)).join("\n")
      : `${preNav}  await test.step('Placeholder step', async () => {\n    // TODO: add steps\n  });`;

  return `
test(${JSON.stringify(title)}, async ({ page }) => {
${emitAnnotations(pagePath, tc.name)}${body}
});`.trim();
}

export function emitSpecFile(pagePath: string, tests: TestCase[]): string {
  const uniqTitle = makeUniqTitleFactory();
  const cases = (tests ?? []).map((tc) => emitTest(tc, uniqTitle, pagePath)).join("\n\n");
  const banner = `// Auto-generated for page ${pagePath} – ${tests?.length ?? 0} test(s)`;

  return `
import { test, expect } from '@playwright/test';

${banner}

${cases}
`.trimStart();
}

export const playwrightTSAdapter = {
  id: "playwright-ts",
  render(plan: TestPlan) {
    const grouped = groupByPage((plan as any).cases ?? []);
    return Array.from(grouped.entries()).map(([page, tests]) => {
      const base = page === "/" ? "home" : page.replace(/\//g, "_").replace(/^_/, "");
      return {
        path: `${base}.spec.ts`,
        content: emitSpecFile(page, tests),
      };
    });
  },
  manifest(plan: TestPlan) {
    const grouped = groupByPage((plan as any).cases ?? []);
    return { pages: Array.from(grouped.keys()), count: (plan as any).cases?.length ?? 0 };
  },
};
