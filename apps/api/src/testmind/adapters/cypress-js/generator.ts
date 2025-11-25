import type { TestPlan } from "../../core/plan.js";

type Step =
  | { kind: "goto"; url: string }
  | { kind: "expect-text"; text: string }
  | { kind: "expect-visible"; selector: string }
  | { kind: "fill"; selector: string; value: string }
  | { kind: "click"; selector: string }
  | { kind: "upload"; selector: string; path: string }
  | { kind: "custom"; note?: string };

type TestCase = {
  id: string;
  name: string;
  group?: { page?: string };
  steps: Step[];
};

function groupByPage(cases: TestCase[]): Map<string, TestCase[]> {
  const grouped = new Map<string, TestCase[]>();
  for (const tc of cases ?? []) {
    const page = tc.group?.page || "/";
    const arr = grouped.get(page) ?? [];
    arr.push(tc);
    grouped.set(page, arr);
  }
  return grouped;
}

function describeStep(step: Step): string {
  switch (step.kind) {
    case "goto":
      return `cy.visit("${step.url}")`;
    case "expect-text":
      return `cy.contains(${JSON.stringify(step.text)}).should("be.visible")`;
    case "expect-visible":
      return `cy.get(${JSON.stringify(step.selector)}).should("be.visible")`;
    case "fill":
      return `cy.get(${JSON.stringify(step.selector)}).clear().type(${JSON.stringify(step.value)})`;
    case "click":
      return `cy.get(${JSON.stringify(step.selector)}).click()`;
    case "upload":
      return `cy.get(${JSON.stringify(step.selector)}).selectFile(${JSON.stringify(step.path)})`;
    default:
      return `// TODO: custom step`;
  }
}

function emitTest(tc: TestCase): string {
  const body =
    tc.steps.length > 0
      ? tc.steps.map((s) => `    ${describeStep(s)}`).join("\n")
      : `    cy.log("TODO: add steps");`;

  return `
  it(${JSON.stringify(tc.name)}, () => {
${body}
  });`.trim();
}

export function emitSpecFile(pagePath: string, tests: TestCase[]): string {
  const cases = (tests ?? []).map((tc) => emitTest(tc)).join("\n\n");
  const baseUrlLine = `const BASE_URL = Cypress.env("BASE_URL") || "${pagePath === "/" ? "" : pagePath}";`;

  return `// Auto-generated for ${pagePath} - ${tests?.length ?? 0} test(s)
${baseUrlLine}

describe(${JSON.stringify(pagePath)}, () => {
${cases}
});
`.trimStart();
}

export function emitCypressConfig(): string {
  return `const { defineConfig } = require("cypress");

module.exports = defineConfig({
  e2e: {
    baseUrl: process.env.BASE_URL || "http://localhost:4173",
    specPattern: "testmind-generated/cypress-js/**/*.cy.js",
    supportFile: false,
    video: false,
  },
});`;
}

export const cypressJSAdapter = {
  id: "cypress-js",
  render(plan: TestPlan) {
    const grouped = groupByPage((plan as any).cases ?? []);
    const files: { path: string; content: string }[] = [];

    for (const [page, tests] of grouped) {
      const base = page === "/" ? "home" : page.replace(/\//g, "_").replace(/^_/, "");
      files.push({
        path: `${base}.cy.js`,
        content: emitSpecFile(page, tests as any),
      });
    }

    files.push({ path: "cypress.config.js", content: emitCypressConfig() });
    return files;
  },
  manifest(plan: TestPlan) {
    const grouped = groupByPage((plan as any).cases ?? []);
    return { pages: Array.from(grouped.keys()), count: (plan as any).cases?.length ?? 0 };
  },
};
