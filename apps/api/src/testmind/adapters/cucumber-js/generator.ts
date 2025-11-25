import type { TestPlan } from "../../core/plan.js";

type Step =
  | { kind: "goto"; url: string }
  | { kind: "expect-text"; text: string }
  | { kind: "expect-visible"; selector: string }
  | { kind: "fill"; selector: string; value: string }
  | { kind: "click"; selector: string }
  | { kind: "upload"; selector: string; path: string };

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

function scenarioTitle(raw: string, seen: Map<string, number>) {
  const base = raw.replace(/\s+/g, " ").trim() || "Scenario";
  const next = (seen.get(base) ?? 0) + 1;
  seen.set(base, next);
  return next === 1 ? base : `${base} [${next}]`;
}

function emitStepLine(step: Step): string {
  switch (step.kind) {
    case "goto":
      return `Given I navigate to "${step.url}"`;
    case "expect-text":
      return `Then I should see text "${step.text}"`;
    case "expect-visible":
      return `Then I should see element "${step.selector}"`;
    case "fill":
      return `When I fill "${step.selector}" with "${step.value}"`;
    case "click":
      return `When I click "${step.selector}"`;
    case "upload":
      return `When I upload "${step.path}" into "${step.selector}"`;
    default:
      return `When I perform "${(step as any).kind}"`;
  }
}

function emitScenario(tc: TestCase, seen: Map<string, number>): string {
  const title = scenarioTitle(tc.name, seen);
  const lines = (tc.steps ?? []).map((s) => `    ${emitStepLine(s)}`);
  const body = lines.length ? lines.join("\n") : "    Then I should see text \"TODO\"";
  return `  Scenario: ${title}\n${body}`;
}

export function emitFeatureFile(pagePath: string, tests: TestCase[]): string {
  const seen = new Map<string, number>();
  const scenarios = (tests ?? []).map((tc) => emitScenario(tc, seen)).join("\n\n");
  const featureName = pagePath === "/" ? "Home" : pagePath.replace(/[/_]+/g, " ").trim();

  return `Feature: ${featureName}
  As a user
  I want to validate ${featureName || "the page"}
  So that it behaves as expected

${scenarios}
`.trimStart();
}

function emitStepDefinitions(): string {
  return `const { Given, When, Then, Before, After } = require('@cucumber/cucumber');
const { chromium } = require('playwright');

Before(async function () {
  this.browser = await chromium.launch({ headless: true });
  this.context = await this.browser.newContext();
  this.page = await this.context.newPage();
  this.baseUrl = process.env.BASE_URL || process.env.TM_BASE_URL || '';
});

After(async function () {
  if (this.context) await this.context.close();
  if (this.browser) await this.browser.close();
});

Given('I navigate to {string}', async function (path) {
  const target = path.startsWith('http') ? path : this.baseUrl + path;
  await this.page.goto(target);
});

When('I click {string}', async function (selector) {
  await this.page.locator(selector).click();
});

When('I fill {string} with {string}', async function (selector, value) {
  await this.page.locator(selector).fill(value);
});

When('I upload {string} into {string}', async function (filePath, selector) {
  await this.page.setInputFiles(selector, filePath);
});

Then('I should see text {string}', async function (text) {
  await this.page.getByText(text).waitFor({ state: 'visible', timeout: 5000 });
});

Then('I should see element {string}', async function (selector) {
  await this.page.locator(selector).waitFor({ state: 'visible', timeout: 5000 });
});
`;
}

export const cucumberJSAdapter = {
  id: "cucumber-js",
  render(plan: TestPlan) {
    const grouped = groupByPage((plan as any).cases ?? []);
    const files: { path: string; content: string }[] = [];

    for (const [page, tests] of grouped) {
      const base = page === "/" ? "home" : page.replace(/\//g, "_").replace(/^_/, "");
      files.push({
        path: `features/${base}.feature`,
        content: emitFeatureFile(page, tests),
      });
      files.push({
        path: `steps/${base}.steps.js`,
        content: `const { Given, When, Then } = require('@cucumber/cucumber');\nconst { chromium, expect } = require('playwright');\n// Reuse shared steps via support/steps.js\nmodule.exports = {};`,
      });
    }

    // shared definitions
    files.push({
      path: `support/steps.js`,
      content: emitStepDefinitions(),
    });

    return files;
  },
  manifest(plan: TestPlan) {
    const grouped = groupByPage((plan as any).cases ?? []);
    return { pages: Array.from(grouped.keys()), count: (plan as any).cases?.length ?? 0 };
  },
};
