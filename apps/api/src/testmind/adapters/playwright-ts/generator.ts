import type { LocatorStore } from "../../runtime/locator-store";
import type { TestPlan } from "../../core/plan";
import fs from "node:fs";
import path from "node:path";
import { normalizeSharedSteps, resolveLocator, LocatorBucket } from "../../runtime/locator-store";

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

type CombinedSharedSteps = SharedStepsConfig & {
  locatorStore: ReturnType<typeof normalizeSharedSteps>;
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
const MISSING_LOCATORS_ENV = "TM_MISSING_LOCATORS_PATH";
const DEFAULT_LOGIN_CONFIG: ResolvedLoginConfig = {
  usernameSelector:
    'input[placeholder="Email Address"], input[name="email"], input[type="email"], input[name="username"], #username, #email',
  passwordSelector:
    'input[placeholder="Password"], input[name="password"], input[type="password"], #password',
  submitSelector: 'button[type="submit"], button:has-text("Login"), button:has-text("Sign in")',
  usernameEnv: "EMAIL_ADDRESS",
  passwordEnv: "PASSWORD",
};

function parseSharedSteps(): CombinedSharedSteps {
  const raw = process.env[SHARED_STEPS_ENV];
  if (!raw) return { locatorStore: normalizeSharedSteps({}) };
  try {
    const parsed = JSON.parse(raw);
    const share = parsed && typeof parsed === "object" ? (parsed as SharedStepsConfig) : {};
    return { ...share, locatorStore: normalizeSharedSteps(parsed) };
  } catch (err) {
    console.warn(`[tm-gen] failed to parse ${SHARED_STEPS_ENV}:`, err);
    return { locatorStore: normalizeSharedSteps({}) };
  }
}

function resolveLoginConfig(shared: CombinedSharedSteps): ResolvedLoginConfig {
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
    const key = derivePageKey(tc);
    const arr = grouped.get(key) ?? [];
    arr.push(tc);
    grouped.set(key, arr);
  }
  return grouped;
}

function derivePageKey(tc: TestCase): string {
  const candidate = tc.group?.url ?? tc.group?.page;
  if (candidate) {
    return toRelativeTarget(candidate);
  }
  const firstGoto = tc.steps?.find((s) => s.kind === "goto");
  if (firstGoto?.url) {
    return toRelativeTarget(firstGoto.url);
  }
  return "/";
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

type MissingLocatorItem = {
  pagePath: string;
  bucket: LocatorBucket;
  name: string;
  stepText: string;
  suggestions: string[];
};

function semanticKeyFromString(value?: string): string {
  if (!value) return "default";
  const cleaned = value
    .toLowerCase()
    .replace(/["']/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || "default";
}

function generateSelectorSuggestions(name: string): string[] {
  const normalized = name.replace(/[^a-z0-9]/g, "");
  const candidates = [];
  if (normalized) {
    candidates.push(`input[name="${normalized}"]`);
    candidates.push(`input[placeholder*="${normalized}"]`);
    candidates.push(`[data-testid*="${normalized}"]`);
  }
  candidates.push("input");
  candidates.push("button");
  return Array.from(new Set(candidates));
}

function extractHrefFromSelector(selector: string): string | undefined {
  const match = selector.match(/href\s*=\s*['"]([^'"]+)['"]/i);
  return match ? match[1] : undefined;
}

type LocatorKind = "click" | "fill" | "expect-visible";
type Region = "navigation" | "header" | "main";

function regionForKind(kind: LocatorKind): Region | undefined {
  if (kind === "click") return "navigation";
  if (kind === "fill") return "main";
  if (kind === "expect-visible") return "main";
  return undefined;
}

function buildLocatorExpression(selector: string, kind: LocatorKind): { expr: string; region?: Region } {
  return {
    expr: `chooseLocator(page, ${JSON.stringify(selector)}, ${JSON.stringify(regionForKind(kind))})`,
    region: regionForKind(kind),
  };
}

function recordMissingLocator(item: MissingLocatorItem) {
  const filePath = process.env[MISSING_LOCATORS_ENV];
  if (!filePath) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  let payload: { items: MissingLocatorItem[] } = { items: [] };
  if (fs.existsSync(filePath)) {
    try {
      payload = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch {
      payload = { items: [] };
    }
  }
  payload.items = payload.items ?? [];
  payload.items.push(item);
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf8");
}

function resolveStepSelector(
  step: Step,
  pagePath: string,
  locatorStore: LocatorStore,
  bucket: LocatorBucket
): { selector?: string; missing?: MissingLocatorItem } {
  const selectorRaw = "selector" in step ? step.selector : undefined;
  const textRaw = step.kind === "expect-text" ? step.text : undefined;
  const rawName = selectorRaw ?? textRaw ?? step.kind;
  const name = semanticKeyFromString(rawName);
  const { selector } = resolveLocator(locatorStore, pagePath, bucket, name);
  if (selector) return { selector };
  const missing: MissingLocatorItem = {
    pagePath,
    bucket,
    name,
    stepText: describeStep(step),
    suggestions: generateSelectorSuggestions(name),
  };
  recordMissingLocator(missing);
  return { missing };
}

function formatMissingLocatorAction(step: Step, detail?: MissingLocatorItem): string {
  const why = detail
    ? `${detail.bucket}.${detail.name} on ${detail.pagePath}`
    : describeStep(step);
  return `// Missing locator ${why}; add it to shared locators and rerun generation.`;
}

function emitAction(step: Step, pagePath: string, locatorStore: LocatorStore): string {
  switch (step.kind) {
    case "goto":
      {
        const rel = toRelativeTarget(step.url);
        return `await navigateTo(page, ${JSON.stringify(rel)});
  await ensurePageIdentity(page, ${JSON.stringify(rel)});`;
      }
    case "expect-text":
      return `{
  const targetPath = identityPathForText(${JSON.stringify(step.text)});
  if (targetPath) {
    await expect(page).toHaveURL(pathRegex(targetPath), { timeout: 15000 });
    await ensurePageIdentity(page, targetPath);
    return;
  }
  await expect(page.getByText(${JSON.stringify(step.text)})).toBeVisible({ timeout: 10000 });
}`;
    case "expect-visible": {
      const resolved = resolveStepSelector(step, pagePath, locatorStore, "locators");
      if (!resolved.selector) {
        return formatMissingLocatorAction(step, resolved.missing);
      }
      const selector = resolved.selector;
      const built = buildLocatorExpression(selector, "expect-visible");
      return `{
  const locator = ${built.expr}.first();
  await locator.waitFor({ state: 'visible', timeout: 10000 });
  await expect(locator).toBeVisible({ timeout: 10000 });
}`;
    }
    case "fill": {
      const resolved = resolveStepSelector(step, pagePath, locatorStore, "fields");
      if (!resolved.selector) {
        return formatMissingLocatorAction(step, resolved.missing);
      }
      const selector = resolved.selector;
      return `{
  const locator = ${buildLocatorExpression(selector, "fill").expr}.first();
  await locator.waitFor({ state: 'visible', timeout: 10000 });
  await locator.fill(${JSON.stringify(step.value)});
}`;
    }
    case "click": {
      const resolved = resolveStepSelector(step, pagePath, locatorStore, "buttons");
      if (!resolved.selector) {
        return formatMissingLocatorAction(step, resolved.missing);
      }
      const selector = resolved.selector;
      const navHref = extractHrefFromSelector(selector);
      if (navHref) {
        const normalizedHref = toRelativeTarget(navHref);
        return `{
  await clickNavLink(page, ${JSON.stringify(normalizedHref)});
  await expect(page).toHaveURL(pathRegex(${JSON.stringify(normalizedHref)}), { timeout: 15000 });
  await ensurePageIdentity(page, ${JSON.stringify(normalizedHref)});
}`;
      }
      const locatorExpr = buildLocatorExpression(selector, "click").expr;
      return `{
  const locator = ${locatorExpr}.first();
  await locator.waitFor({ state: 'visible', timeout: 10000 });
  await locator.click({ timeout: 10000 });
}`;
    }
    case "upload": {
      const resolved = resolveStepSelector(step, pagePath, locatorStore, "fields");
      if (!resolved.selector) {
        return formatMissingLocatorAction(step, resolved.missing);
      }
      const selector = resolved.selector;
      return `{
  const locator = page.locator(${JSON.stringify(selector)}).first();
  await locator.waitFor({ state: 'visible', timeout: 10000 });
  await locator.setInputFiles(${JSON.stringify(step.path)});
}`;
    }
    default:
      return `// TODO: custom step`;
  }
}

function emitStep(step: Step, index: number, pagePath: string, locatorStore: LocatorStore): string {
  const title = `${index + 1}. ${describeStep(step)}`;
  const action = emitAction(step, pagePath, locatorStore)
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
  return `  await test.step(${JSON.stringify(title)}, async () => {\n${action}\n  });`;
}

function isHomeTextStep(step: Step): boolean {
  if (step.kind !== 'expect-text') return false;
  const text = (step.text ?? '').toLowerCase().trim();
  if (!text) return false;
  return (
    text === 'page' ||
    text.includes('justicepath') ||
    text.includes('accessible legal help')
  );
}

function makePostLoginCheck(): string {
  return `  await test.step('Ensure case-type-selection page loads after login', async () => {
    await expect
      .poll(() => new URL(page.url()).pathname)
      .toContain('/case-type-selection');
    await ensurePageIdentity(page, '/case-type-selection');
  });`;
}

function isLoginFieldStep(step: Step): boolean {
  if (!("selector" in step) || !step.selector) return false;
  const target = step.selector.toLowerCase();
  return /user|email|pass|login/.test(target);
}

function isLoginSuccessCheck(step: Step): boolean {
  if (step.kind !== "expect-text") return false;
  const text = (step.text ?? "").toLowerCase();
  return /success|logged in/.test(text);
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

function emitTest(tc: TestCase, uniqTitle: (s: string) => string, pagePath: string, locatorStore: LocatorStore): string {
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
  const postLoginCheck = makePostLoginCheck();
  const stepStrings: string[] = [];
  let loginInserted = false;
  let postLoginStepAdded = false;
  tc.steps.forEach((step, idx) => {
    if (needsLogin && loginInserted && isHomeTextStep(step)) {
      return;
    }
    if (needsLogin && isLoginFieldStep(step)) {
      return;
    }
    if (needsLogin && isLoginSuccessCheck(step)) {
      return;
    }
    const stepStr = emitStep(step, idx, pagePath, locatorStore);
    if (!stepStr.trim()) {
      return;
    }
    stepStrings.push(stepStr);
    if (needsLogin && !loginInserted && step.kind === "goto") {
      stepStrings.push(loginCall);
      loginInserted = true;
      if (!postLoginStepAdded) {
        stepStrings.push(postLoginCheck);
        postLoginStepAdded = true;
      }
    }
  });
  if (needsLogin && !loginInserted && loginCall) {
    stepStrings.push(loginCall);
    loginInserted = true;
    if (!postLoginStepAdded) {
      stepStrings.push(postLoginCheck);
      postLoginStepAdded = true;
    }
  }

  let body = preNav;
  if (needsLogin && !loginInserted && loginCall) {
    body += `${loginCall}\n`;
    loginInserted = true;
    if (!postLoginStepAdded) {
      body += `${postLoginCheck}\n`;
      postLoginStepAdded = true;
    }
  }
  if (stepStrings.length > 0) {
    body += stepStrings.join("\n");
  } else {
    body += `  await test.step('Placeholder step', async () => {\n    throw new Error("No recorded steps for this test. Add selectors or actions.");\n  });`;
  }

  return `
test(${JSON.stringify(title)}, async ({ page }) => {
${emitAnnotations(pagePath, tc.name)}${body}
});`.trim();
}

export function emitSpecFile(pagePath: string, tests: TestCase[]): string {
  const sharedSteps = parseSharedSteps();
  const loginConfig = resolveLoginConfig(sharedSteps);
  const locatorStore = sharedSteps.locatorStore;
  const uniqTitle = makeUniqTitleFactory();
  const cases = (tests ?? []).map((tc) => emitTest(tc, uniqTitle, pagePath, locatorStore)).join("\n\n");
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
    "  '/case-type-selection': { kind: 'text', text: \"Select the type of legal issue you\'re dealing with:\" },",
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
    "  const withoutQuery = normalized.split('?')[0] || normalized;",
    "  let identity = PAGE_IDENTITIES[normalized] ?? PAGE_IDENTITIES[withoutQuery];",
    "  if (!identity) {",
    "    const candidates = Object.entries(PAGE_IDENTITIES).filter(([route]) =>",
    "      matchesIdentityPrefix(withoutQuery, route)",
    "    );",
    "    if (candidates.length) {",
    "      identity = candidates.sort((a, b) => b[0].length - a[0].length)[0][1];",
    "    }",
    "  }",
    "  if (!identity) return;",
    "  switch (identity.kind) {",
    "    case 'role':",
    "      await expect(",
    "        page.getByRole(identity.role, { name: identity.name })",
    "      ).toBeVisible({ timeout: IDENTITY_CHECK_TIMEOUT });",
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
    "function matchesIdentityPrefix(route: string, prefix: string): boolean {",
    "  const normalizedPrefix = prefix || '/';",
    "  if (normalizedPrefix === '/') {",
    "    return route === '/';",
    "  }",
    "  if (route === normalizedPrefix) {",
    "    return true;",
    "  }",
    "  const prefixWithSlash = normalizedPrefix.endsWith('/') ? normalizedPrefix : `${normalizedPrefix}/`;",
    "  return route.startsWith(prefixWithSlash);",
    "}",
    "",
    "type Region = 'navigation' | 'header' | 'main';",
    "",
    "function getAttributeValue(selector: string, attr: string): string | undefined {",
    "  const regex = new RegExp(`${attr}\\s*=\\s*['\"]([^'\"]+)['\"]`, 'i');",
    "  const match = selector.match(regex);",
    "  return match ? match[1] : undefined;",
    "}",
    "",
    "function regionScope(page: Page, region?: Region) {",
    "  switch (region) {",
    "    case 'navigation':",
    "      return page.getByRole('navigation');",
    "    case 'header':",
    "      return page.locator('header');",
    "    case 'main':",
    "      return page.locator('main');",
    "    default:",
    "      return page;",
    "  }",
    "}",
    "",
    "function chooseLocator(page: Page, selector: string, region?: Region) {",
    "  const scope = regionScope(page, region);",
    "  const testId = getAttributeValue(selector, 'data-testid');",
    "  if (testId) {",
    "    return scope.getByTestId(testId);",
    "  }",
    "  const role = getAttributeValue(selector, 'role');",
    "  if (role) {",
    "    const name = getAttributeValue(selector, 'name');",
    "    return scope.getByRole(role, name ? { name } : undefined);",
    "  }",
    "  return scope.locator(selector);",
    "}",
    "",
    "function escapeRegex(value: string): string {",
    "  return value.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&');",
    "}",
    "",
    "function pathRegex(target: string): RegExp {",
    "  const escaped = escapeRegex(target);",
    "  return new RegExp(`^${escaped}(?:$|[?#/])`);",
    "}",
    "",
    "function identityPathForText(text?: string): string | undefined {",
    "  if (!text) return undefined;",
    "  const normalized = text.trim().toLowerCase();",
    "  if (!normalized) return undefined;",
    "  for (const [path, identity] of Object.entries(PAGE_IDENTITIES)) {",
    "    if (identity.kind === 'role' && identity.name?.toLowerCase() === normalized) {",
    "      return path;",
    "    }",
    "    if (identity.kind === 'text' && identity.text?.toLowerCase().includes(normalized)) {",
    "      return path;",
    "    }",
    "  }",
    "  return undefined;",
    "}",
    "",
    "async function clickNavLink(page: Page, target: string): Promise<void> {",
    "  const normalizedPath = normalizeIdentityPath(target);",
    "  const targetSelector = `a[href=\"${normalizedPath}\"]`;",
    "  const scopes = [",
    "    page.getByRole('navigation'),",
    "    page.locator('header'),",
    "    page.locator('main'),",
    "  ];",
    "  for (const scope of scopes) {",
    "    const link = scope.locator(targetSelector);",
    "    if (await link.count()) {",
    "      const candidate = link.first();",
    "      await candidate.waitFor({ state: 'visible', timeout: 15000 });",
    "      await candidate.click({ timeout: 15000 });",
    "      return;",
    "    }",
    "  }",
    "  const fallback = page.locator(targetSelector).first();",
    "  await fallback.waitFor({ state: 'visible', timeout: 15000 });",
    "  await fallback.click({ timeout: 15000 });",
    "}",
    "",
    `const SHARED_LOGIN_CONFIG = ${JSON.stringify(loginConfig, null, 2)};`,
    "",
    "async function navigateTo(page: Page, target: string) {",
    "  const url = new URL(target, BASE_URL);",
    "  await page.goto(url.toString(), { waitUntil: 'domcontentloaded' });",
    "  await assertNavigationPath(page, url);",
    "}",
    "",
    "async function assertNavigationPath(page: Page, expectedUrl: URL) {",
    "  const currentUrl = new URL(await page.url());",
    "  const expectedPath = expectedUrl.pathname || '/';",
    "  if (currentUrl.origin !== expectedUrl.origin) {",
    "    throw new Error(`Expected origin ${expectedUrl.origin} but saw ${currentUrl.origin}`);",
    "  }",
    "  if (expectedPath === '/') {",
    "    if (currentUrl.pathname !== '/') {",
    "      throw new Error(`Expected pathname / but saw ${currentUrl.pathname}`);",
    "    }",
    "    return;",
    "  }",
    "  if (currentUrl.pathname === expectedPath) {",
    "    return;",
    "  }",
    "  const expectedWithSlash = expectedPath.endsWith('/') ? expectedPath : `${expectedPath}/`;",
    "  if (!currentUrl.pathname.startsWith(expectedWithSlash)) {",
    "    throw new Error(`Expected pathname to start with ${expectedPath} but saw ${currentUrl.pathname}`);",
    "  }",
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
