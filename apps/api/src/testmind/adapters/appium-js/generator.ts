import type { TestPlan } from "../../core/plan.js";

type Step =
  | { kind: "goto"; url: string }
  | { kind: "expect-text"; text: string }
  | { kind: "expect-visible"; selector: string }
  | { kind: "fill"; selector: string; value: string }
  | { kind: "click"; selector: string }
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
    const page = tc.group?.page || "app";
    const arr = grouped.get(page) ?? [];
    arr.push(tc);
    grouped.set(page, arr);
  }
  return grouped;
}

function emitStep(step: Step): string {
  switch (step.kind) {
    case "goto":
      return `// Navigate: ${step.url}`;
    case "expect-text":
      return `await driver.$(\`xpath=//*[contains(., ${JSON.stringify(step.text)})]\`).waitForDisplayed();`;
    case "expect-visible":
      return `await driver.$(${JSON.stringify(step.selector)}).waitForDisplayed();`;
    case "fill":
      return `await driver.$(${JSON.stringify(step.selector)}).setValue(${JSON.stringify(step.value)});`;
    case "click":
      return `await driver.$(${JSON.stringify(step.selector)}).click();`;
    default:
      return `// TODO: custom step`;
  }
}

function emitTest(tc: TestCase): string {
  const body =
    tc.steps.length > 0
      ? tc.steps.map((s) => `    ${emitStep(s)}`).join("\n")
      : `    // TODO: add steps`;

  return `
  it(${JSON.stringify(tc.name)}, async () => {
${body}
  });`.trim();
}

export function emitSpecFile(page: string, tests: TestCase[]): string {
  const cases = (tests ?? []).map((tc) => emitTest(tc)).join("\n\n");
  return `const { remote } = require('webdriverio');

describe(${JSON.stringify(page)}, () => {
  let driver;

  before(async () => {
    driver = await remote({
      hostname: process.env.APPIUM_HOST || "127.0.0.1",
      port: Number(process.env.APPIUM_PORT || 4723),
      logLevel: "error",
      capabilities: {
        platformName: process.env.APPIUM_PLATFORM || "Android",
        "appium:deviceName": process.env.APPIUM_DEVICE || "Android Emulator",
        "appium:platformVersion": process.env.APPIUM_PLATFORM_VERSION || "12.0",
        "appium:app": process.env.APPIUM_APP || "",
        "appium:automationName": process.env.APPIUM_AUTOMATION || "UiAutomator2"
      }
    });
  });

  after(async () => {
    if (driver) await driver.deleteSession();
  });

${cases}
});
`.trimStart();
}

export function emitAppiumConfig(): string {
  return `// Placeholder for Appium config. Provide env vars for capabilities.`;
}

export const appiumJSAdapter = {
  id: "appium-js",
  render(plan: TestPlan) {
    const grouped = groupByPage((plan as any).cases ?? []);
    const files: { path: string; content: string }[] = [];

    for (const [page, tests] of grouped) {
      const base = page.replace(/[\\/]/g, "_") || "app";
      files.push({
        path: `${base}.spec.js`,
        content: emitSpecFile(page, tests as any),
      });
    }

    files.push({ path: "appium.config.js", content: emitAppiumConfig() });
    return files;
  },
  manifest(plan: TestPlan) {
    const grouped = groupByPage((plan as any).cases ?? []);
    return { pages: Array.from(grouped.keys()), count: (plan as any).cases?.length ?? 0 };
  },
};
