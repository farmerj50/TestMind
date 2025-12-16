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
  group?: { page?: string; url?: string };
  steps: Step[];
};

type SharedLoginConfigSpec = {
  usernameSelector?: string;
  passwordSelector?: string;
  submitSelector?: string;
  usernameEnv?: string;
  passwordEnv?: string;
  usernameValue?: string;
  passwordValue?: string;
};

type SharedStepsConfig = {
  login?: SharedLoginConfigSpec;
};

type ResolvedLoginConfig = {
  usernameSelector: string;
  passwordSelector: string;
  submitSelector: string;
  usernameEnv: string;
  passwordEnv: string;
  usernameValue?: string;
  passwordValue?: string;
};

const SHARED_STEPS_ENV = "TM_PROJECT_SHARED_STEPS";
const DEFAULT_LOGIN_CONFIG: ResolvedLoginConfig = {
  usernameSelector:
    'input[placeholder="Email Address"], input[name="email"], input[type="email"], input[name="username"], #username, #email',
  passwordSelector:
    'input[placeholder="Password"], input[name="password"], input[type="password"], #password',
  submitSelector: 'button[type="submit"], button:has-text("Login"), button:has-text("Sign in")',
  usernameEnv: "USERNAME",
  passwordEnv: "PASSWORD",
};

function parseSharedSteps(): SharedStepsConfig {
  const raw = process.env[SHARED_STEPS_ENV];
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed;
  } catch (err) {
    console.warn(`[tm-gen] failed to parse ${SHARED_STEPS_ENV}:`, err);
  }
  return {};
}

function resolveLoginConfig(shared: SharedStepsConfig): ResolvedLoginConfig {
  const login = shared.login ?? {};
  const trim = (value?: string) => (value && value.trim() ? value.trim() : undefined);
  return {
    usernameSelector: trim(login.usernameSelector) ?? DEFAULT_LOGIN_CONFIG.usernameSelector,
    passwordSelector: trim(login.passwordSelector) ?? DEFAULT_LOGIN_CONFIG.passwordSelector,
    submitSelector: trim(login.submitSelector) ?? DEFAULT_LOGIN_CONFIG.submitSelector,
    usernameEnv: trim(login.usernameEnv) ?? DEFAULT_LOGIN_CONFIG.usernameEnv,
    passwordEnv: trim(login.passwordEnv) ?? DEFAULT_LOGIN_CONFIG.passwordEnv,
    usernameValue: login.usernameValue,
    passwordValue: login.passwordValue,
  };
}

export function groupByPage(cases: TestCase[]): Map<string, TestCase[]> {
  const grouped = new Map<string, TestCase[]>();
  for (const tc of cases ?? []) {
    const key = tc.group?.url || tc.group?.page || "/";
    const arr = grouped.get(key) ?? [];
    arr.push(tc);
    grouped.set(key, arr);
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

function toRelativeTarget(url: string | undefined): string {
  if (!url) return "/";
  try {
    const parsed = new URL(url);
    const rel = `${parsed.pathname || "/"}${parsed.search || ""}${parsed.hash || ""}`;
    return rel || "/";
  } catch {
    if (url.startsWith("/")) return url;
    return `/${url}`;
  }
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
      {
        const rel = toRelativeTarget(step.url);
        return `await navigateTo(page, ${JSON.stringify(rel)});
  await ensurePageIdentity(page, ${JSON.stringify(rel)});`;
      }
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
  const navTarget = toRelativeTarget(tc.group?.url || pagePath);
  const preNav = hasGoto
    ? ""
    : `  // Auto-nav added because no explicit goto step was provided\n  await navigateTo(page, ${JSON.stringify(navTarget)});\n  await ensurePageIdentity(page, ${JSON.stringify(navTarget)});\n`;

  const needsLogin =
    /login/i.test(tc.name) ||
    /signin/i.test(tc.name) ||
    /sign in/i.test(tc.name) ||
    /auth/i.test(tc.name) ||
    tc.steps.some(
      (s) =>
        s.kind === "fill" &&
        typeof s.selector === "string" &&
        /(user|email|pass)/i.test(s.selector)
    );

  const loginCall = needsLogin ? "  await sharedLogin(page);" : "";

  const stepStrings: string[] = [];
  let loginInserted = false;
  tc.steps.forEach((step, idx) => {
    const stepStr = emitStep(step, idx);
    stepStrings.push(stepStr);
    if (needsLogin && !loginInserted && step.kind === "goto") {
      stepStrings.push(loginCall);
      loginInserted = true;
    }
  });

  let body = preNav;
  if (needsLogin && !loginInserted && loginCall) {
    body += `${loginCall}\n`;
    loginInserted = true;
  }
  if (stepStrings.length > 0) {
    body += stepStrings.join("\n");
  } else {
    body += `  await test.step('Placeholder step', async () => {\n    // TODO: add steps\n  });`;
  }

  return `
test(${JSON.stringify(title)}, async ({ page }) => {
${emitAnnotations(pagePath, tc.name)}${body}
});`.trim();
}

export function emitSpecFile(pagePath: string, tests: TestCase[]): string {
  const sharedSteps = parseSharedSteps();
  const loginConfig = resolveLoginConfig(sharedSteps);
  const uniqTitle = makeUniqTitleFactory();
  const cases = (tests ?? []).map((tc) => emitTest(tc, uniqTitle, pagePath)).join("\n\n");
  const banner = `// Auto-generated for page ${pagePath} – ${tests?.length ?? 0} test(s)`;
  const helperLines = [
    "import { Page, test, expect } from '@playwright/test';",
    "",
    "const BASE_URL = process.env.BASE_URL ?? 'https://justicepathlaw.com';",
    "",
    "type IdentityDescriptor =",
    "  | { kind: 'role'; role: string; name: string }",
    "  | { kind: 'text'; text: string }",
    "  | { kind: 'locator'; selector: string };",
    "",
    "const PAGE_IDENTITIES: Record<string, IdentityDescriptor> = {",
    "  '/': { kind: 'role', role: 'heading', name: 'Accessible Legal Help for Everyone' },",
    "  '/login': { kind: 'role', role: 'heading', name: 'Login' },",
    "  '/signup': { kind: 'role', role: 'heading', name: 'Sign Up' },",
    "  '/case-type-selection': { kind: 'text', text: \"Select the type of legal issue you're dealing with:\" },",
    "  '/pricing': { kind: 'role', role: 'heading', name: 'Choose Your Plan' },",
    "};",
    "",
    "const IDENTITY_CHECK_TIMEOUT = 10000;",
    "",
    "function normalizeIdentityPath(target: string): string {",
    "  if (!target) return '/';",
    "  try {",
    "    const parsed = new URL(target, BASE_URL);",
    "    const path = parsed.pathname || '/';",
    "    const search = parsed.search || '';",
    "    return `${path}${search}` || '/';",
    "  } catch {",
    "    if (target.startsWith('/')) return target;",
    "    return `/${target}`;",
    "  }",
    "}",
    "",
    "async function ensurePageIdentity(page: Page, target: string) {",
    "  const normalized = normalizeIdentityPath(target);",
    "  let identity = PAGE_IDENTITIES[normalized];",
    "  if (!identity) {",
    "    const withoutQuery = normalized.split('?')[0] || normalized;",
    "    identity = PAGE_IDENTITIES[withoutQuery];",
    "  }",
    "  if (!identity) return;",
    "  switch (identity.kind) {",
    "    case 'role':",
    "      await expect(page.getByRole(identity.role, { name: identity.name })).toBeVisible({ timeout: IDENTITY_CHECK_TIMEOUT });",
    "      break;",
    "    case 'text':",
    "      await expect(page.getByText(identity.text)).toBeVisible({ timeout: IDENTITY_CHECK_TIMEOUT });",
    "      break;",
    "    case 'locator': {",
    "      const locator = page.locator(identity.selector);",
    "      await locator.waitFor({ state: 'visible', timeout: IDENTITY_CHECK_TIMEOUT });",
    "      await expect(locator).toBeVisible({ timeout: IDENTITY_CHECK_TIMEOUT });",
    "      break;",
    "    }",
    "  }",
    "}",
    "",
    `const SHARED_LOGIN_CONFIG = ${JSON.stringify(loginConfig, null, 2)};`,
    "",
    "async function navigateTo(page: Page, target: string) {",
  "  const url = new URL(target, BASE_URL);",
  "  await page.goto(url.toString(), { waitUntil: 'domcontentloaded' });",
  "  await expect(page).toHaveURL(url.toString());",
  "}",
    "",
    "async function sharedLogin(page: Page) {",
    "  const usernameEnv = SHARED_LOGIN_CONFIG.usernameEnv;",
    "  const passwordEnv = SHARED_LOGIN_CONFIG.passwordEnv;",
    "  const envUsername = process.env[usernameEnv] ?? process.env.EMAIL ?? '';",
    "  const envPassword = process.env[passwordEnv] ?? process.env.PASSWORD ?? '';",
    "  const username = SHARED_LOGIN_CONFIG.usernameValue ?? envUsername;",
    "  const password = SHARED_LOGIN_CONFIG.passwordValue ?? envPassword;",
    "  const userLocator = page.locator(SHARED_LOGIN_CONFIG.usernameSelector);",
    "  await userLocator.first().waitFor({ state: 'visible', timeout: 30000 });",
    "  await userLocator.first().fill(username);",
    "  const passLocator = page.locator(SHARED_LOGIN_CONFIG.passwordSelector);",
    "  await passLocator.first().waitFor({ state: 'visible', timeout: 30000 });",
    "  await passLocator.first().fill(password);",
    "  if (SHARED_LOGIN_CONFIG.submitSelector) {",
    "    const submit = page.locator(SHARED_LOGIN_CONFIG.submitSelector);",
    "    if (await submit.first().isVisible()) {",
    "      await submit.first().click({ timeout: 10000 });",
    "    }",
    "  }",
    "}",
  ];
  const helper = helperLines.join("\n");

  return `
${helper}

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
