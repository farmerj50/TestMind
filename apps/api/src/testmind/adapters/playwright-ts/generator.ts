import type { LocatorStore, LocatorPage } from "../../runtime/locator-store.js";
import type { TestPlan } from "../../core/plan.js";
import fs from "node:fs";
import path from "node:path";
import { normalizeSharedSteps, resolveLocator, LocatorBucket } from "../../runtime/locator-store.js";

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
  postLoginPath?: string;
};

type SharedStepsConfig = {
  login?: SharedLoginConfigSpec;
  baseUrl?: string;
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

function normalizeCandidateSelector(value?: string): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  let match = trimmed.match(/(?:page\.)?locator\(\s*['"`]([^'"`]+)['"`]\s*\)/i);
  if (match) return match[1];
  match = trimmed.match(/getByText\(\s*['"`]([^'"`]+)['"`]\s*\)/i);
  if (match) return `text=${match[1]}`;
  match = trimmed.match(/text\s*=\s*['"`]([^'"`]+)['"`]/i);
  if (match) return `text=${match[1]}`;
  if (trimmed.startsWith("//")) return trimmed;
  if (/[#.[\]=:]/.test(trimmed)) return trimmed;
  return null;
}

function extractLikelySelector(value?: string): string | null {
  if (!value) return null;
  const raw = value.trim();
  if (!raw) return null;
  const match =
    raw.match(/(input\[[^\]]+\]|button\[[^\]]+\]|a\[[^\]]+\]|select\[[^\]]+\]|textarea\[[^\]]+\])/i) ||
    raw.match(/(\[[^\]]+\])/i) ||
    raw.match(/([#.][a-z0-9_-]+)/i);
  return match ? match[1] : null;
}

function escapeQuotes(value: string): string {
  return value.replace(/"/g, '\\"');
}

function generateSelectorSuggestions(rawName: string, selectorRaw?: string, textRaw?: string): string[] {
  const candidates: string[] = [];
  const push = (value?: string | null) => {
    if (!value) return;
    const trimmed = value.trim();
    if (!trimmed) return;
    candidates.push(trimmed);
  };

  push(normalizeCandidateSelector(selectorRaw));
  push(extractLikelySelector(selectorRaw));
  push(extractLikelySelector(rawName));

  if (textRaw) {
    const safeText = escapeQuotes(textRaw);
    push(`text=${safeText}`);
    if (safeText.length <= 80) {
      push(`:has-text("${safeText}")`);
    }
  }

  const normalized = semanticKeyFromString(rawName);
  if (normalized && normalized.length <= 32) {
    push(`input[name="${normalized}"]`);
    push(`input[placeholder*="${normalized}"]`);
    push(`[data-testid*="${normalized}"]`);
  }

  push("input");
  push("button");
  return Array.from(new Set(candidates));
}

function navKeysForRoute(target: string): string[] {
  const cleaned = target.replace(/^\//, "");
  if (!cleaned) return [];
  const kebab = cleaned
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const camel = kebab.replace(/-([a-z0-9])/g, (_match, ch) => ch.toUpperCase());
  const keys = new Set<string>();
  if (kebab) keys.add(`nav.${kebab}`);
  if (camel) keys.add(`nav.${camel}`);
  keys.add(`nav.${cleaned.toLowerCase()}`);
  return Array.from(keys);
}

function resolveNavLocator(store: LocatorStore, targetPath: string): { selector: string; key: string } | null {
  const keys = navKeysForRoute(targetPath);
  for (const key of keys) {
    const selector = store.nav?.[key];
    if (selector) return { selector, key };
  }
  const page = store.pages?.["/"];
  if (!page) return null;
  for (const key of keys) {
    const selector =
      page.locators?.[key] ??
      page.buttons?.[key] ??
      page.links?.[key];
    if (selector) return { selector, key };
  }
  return null;
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
    suggestions: generateSelectorSuggestions(rawName, selectorRaw, textRaw),
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
  const rawText = ${JSON.stringify(step.text)};
  if (/justicepath/i.test(rawText) && ${JSON.stringify(pagePath)} !== "/") {
    await ensurePageIdentity(page, ${JSON.stringify(pagePath)});
    return;
  }
  if (rawText.trim().toLowerCase() === "page") {
    await expect(page).toHaveURL(pathRegex(${JSON.stringify(pagePath)}), { timeout: 15000 });
    await ensurePageIdentity(page, ${JSON.stringify(pagePath)});
    return;
  }
  const normalized = rawText.trim().toLowerCase();
  const routeCandidate = normalized.startsWith("/") ? normalized : \`/\${normalized}\`;
  const routeLike = /^[a-z0-9\\-/]+$/.test(normalized) && normalized !== "page";
  if (routeLike) {
    await expect(page).toHaveURL(pathRegex(routeCandidate), { timeout: 15000 });
    await ensurePageIdentity(page, routeCandidate);
    return;
  }
  const targetPath = identityPathForText(rawText);
  if (targetPath) {
    await expect(page).toHaveURL(pathRegex(targetPath), { timeout: 15000 });
    await ensurePageIdentity(page, targetPath);
    return;
  }
  await expect(page.getByText(rawText)).toBeVisible({ timeout: 10000 });
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
      const selectorRaw = "selector" in step ? step.selector : undefined;
      const routeCandidate = selectorRaw ? toRelativeTarget(selectorRaw) : null;
      const routeLike =
        !!routeCandidate &&
        routeCandidate !== "/" &&
        /^[a-z0-9\-/]+$/.test(routeCandidate.slice(1));
      if (routeLike) {
        const nav = resolveNavLocator(locatorStore, routeCandidate);
        if (!nav) {
          const navKey = navKeysForRoute(routeCandidate)[0] ?? `nav.${semanticKeyFromString(routeCandidate)}`;
          const missing: MissingLocatorItem = {
            pagePath: "/",
            bucket: "locators",
            name: navKey,
            stepText: `Navigate to ${routeCandidate}`,
            suggestions: generateSelectorSuggestions(navKey, selectorRaw),
          };
          recordMissingLocator(missing);
          return formatMissingLocatorAction(step, missing);
        }
        const locatorExpr = buildLocatorExpression(nav.selector, "click").expr;
        return `{
  const locator = ${locatorExpr}.first();
  await locator.waitFor({ state: 'visible', timeout: 10000 });
  await locator.click({ timeout: 10000 });
  await expect(page).toHaveURL(pathRegex(${JSON.stringify(routeCandidate)}), { timeout: 15000 });
  await ensurePageIdentity(page, ${JSON.stringify(routeCandidate)});
}`;
      }
      let resolved = resolveStepSelector(step, pagePath, locatorStore, "buttons");
      if (!resolved.selector) {
        resolved = resolveStepSelector(step, pagePath, locatorStore, "links");
      }
      if (!resolved.selector) {
        resolved = resolveStepSelector(step, pagePath, locatorStore, "locators");
      }
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

function makePostLoginCheck(postLoginPath?: string): string {
  const target = postLoginPath?.trim();
  if (!target) return "";
  return `  await test.step('Ensure post-login page loads', async () => {
    await expect(page).toHaveURL(pathRegex(${JSON.stringify(target)}), { timeout: 15000 });
    await ensurePageIdentity(page, ${JSON.stringify(target)});
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

function emitTest(
  tc: TestCase,
  uniqTitle: (s: string) => string,
  pagePath: string,
  locatorStore: LocatorStore,
  postLoginPath?: string
): string {
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
  const postLoginCheck = makePostLoginCheck(postLoginPath);
  const stepStrings: string[] = [];
  let loginInserted = false;
  let postLoginStepAdded = false;
  tc.steps.forEach((step, idx) => {
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
      if (postLoginCheck && !postLoginStepAdded) {
        stepStrings.push(postLoginCheck);
        postLoginStepAdded = true;
      }
    }
  });
  if (needsLogin && !loginInserted && loginCall) {
    stepStrings.push(loginCall);
    loginInserted = true;
    if (postLoginCheck && !postLoginStepAdded) {
      stepStrings.push(postLoginCheck);
      postLoginStepAdded = true;
    }
  }

  let body = preNav;
  if (needsLogin && !loginInserted && loginCall) {
    body += `${loginCall}\n`;
    loginInserted = true;
    if (postLoginCheck && !postLoginStepAdded) {
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
  const postLoginPath = sharedSteps.login?.postLoginPath?.trim();
  const baseUrl = sharedSteps.baseUrl?.trim();
  const baseUrlLiteral = baseUrl
    ? JSON.stringify(baseUrl)
    : "process.env.TM_BASE_URL ?? process.env.TEST_BASE_URL ?? process.env.BASE_URL ?? 'http://localhost:5173'";
  const cases = (tests ?? []).map((tc) =>
    emitTest(tc, uniqTitle, pagePath, locatorStore, postLoginPath)
  ).join("\n\n");
  const banner = `// Auto-generated for page ${pagePath} ${tests?.length ?? 0} test(s)`;
  const isPlaceholderIdentityText = (text?: string) =>
    typeof text === "string" && text.trim().toLowerCase() === "page";
  const normalizeIdentitySelector = (selector: string): string => {
    const match = selector.match(/input\[name=(?:"([^"]+)"|'([^']+)')\]/i);
    const nameValue = match?.[1] ?? match?.[2];
    if (nameValue && /\s/.test(nameValue)) {
      return `text=${nameValue}`;
    }
    return selector;
  };
  const resolveIdentityFallback = (page: LocatorPage | undefined) => {
    const selector =
      page?.locators?.pageIdentity ||
      page?.locators?.page ||
      page?.locators?.identity ||
      page?.locators?.root;
    if (!selector) return null;
    return { kind: "locator", selector: normalizeIdentitySelector(selector) } as const;
  };
  const pageIdentities = Object.entries(locatorStore.pages ?? {}).reduce<Record<string, any>>(
    (acc, [key, page]) => {
      const fallback = resolveIdentityFallback(page);
      if (fallback) {
        acc[key] = fallback;
        return acc;
      }
      const identity = page?.identity;
      if (identity && typeof identity === "object") {
        if (identity.kind === "role" && identity.role && identity.name) {
          acc[key] = { kind: "role", role: identity.role, name: identity.name };
          return acc;
        }
        if (identity.kind === "text" && identity.text && !isPlaceholderIdentityText(identity.text)) {
          acc[key] = { kind: "text", text: identity.text };
          return acc;
        }
        if (identity.kind === "locator" && identity.selector) {
          acc[key] = { kind: "locator", selector: normalizeIdentitySelector(identity.selector) };
          return acc;
        }
      }
      return acc;
    },
    {}
  );
    const helperLines = [
    "import fs from 'node:fs/promises';",
    "import path from 'node:path';",
    "import { Page, test, expect } from '@playwright/test';",
    "",
    `const BASE_URL = ${baseUrlLiteral};`,
    "const RUN_LOG_DIR = process.env.TM_RUN_LOG_DIR || process.env.PW_OUTPUT_DIR;",
    "const LIVE_PREVIEW_ENABLED = process.env.TM_LIVE_PREVIEW === '1';",
    "",
    "type PageSignals = {",
    "  url?: string;",
    "  console: { type: string; text: string; location?: { url?: string; lineNumber?: number; columnNumber?: number } }[];",
    "  pageErrors: string[];",
    "  requestFailed: { url: string; errorText?: string }[];",
    "  dom: { title?: string; h1?: string; bodyText?: string; htmlSnippet?: string };",
    "};",
    "",
    "const SIGNALS = new WeakMap<Page, PageSignals>();",
    "const LIVE_PREVIEW_STOP = new WeakMap<Page, () => void>();",
    "",
    "function attachPageSignals(page: Page): PageSignals {",
    "  const signals: PageSignals = { console: [], pageErrors: [], requestFailed: [], dom: {} };",
    "  page.on('console', (msg) => {",
    "    signals.console.push({",
    "      type: msg.type(),",
    "      text: msg.text().slice(0, 500),",
    "      location: msg.location?.(),",
    "    });",
    "  });",
    "  page.on('pageerror', (err) => signals.pageErrors.push(String(err).slice(0, 800)));",
    "  page.on('requestfailed', (req) => {",
    "    signals.requestFailed.push({ url: req.url(), errorText: req.failure()?.errorText });",
    "  });",
    "  SIGNALS.set(page, signals);",
    "  return signals;",
    "}",
    "",
    "async function snapshotSignals(page: Page, signals: PageSignals) {",
    "  try {",
    "    signals.url = page.url();",
    "    signals.dom.title = await page.title().catch(() => undefined);",
    "    signals.dom.h1 = await page.locator('h1').first().innerText().catch(() => undefined);",
    "    signals.dom.bodyText = (await page.locator('body').innerText().catch(() => '')).slice(0, 2000);",
    "    signals.dom.htmlSnippet = (await page.content().catch(() => '')).slice(0, 2000);",
    "  } catch {",
    "    // ignore snapshot failures",
    "  }",
    "}",
    "",
    "async function writeSignals(page: Page, testInfo: any) {",
    "  if (!RUN_LOG_DIR) return;",
    "  const signals = SIGNALS.get(page) ?? attachPageSignals(page);",
    "  await snapshotSignals(page, signals);",
    "  const payload = {",
    "    title: testInfo.title,",
    "    status: testInfo.status,",
    "    expectedStatus: testInfo.expectedStatus,",
    "    file: testInfo.file,",
    "    line: testInfo.line,",
    "    signals,",
    "  };",
    "  await fs.mkdir(RUN_LOG_DIR, { recursive: true });",
    "  await fs.writeFile(path.join(RUN_LOG_DIR, 'page-signals.json'), JSON.stringify(payload, null, 2));",
    "}",
    "",
    "function startLivePreview(page: Page) {",
    "  if (!LIVE_PREVIEW_ENABLED || !RUN_LOG_DIR) return;",
    "  const liveDir = path.join(RUN_LOG_DIR, 'live');",
    "  let stopped = false;",
    "  const capture = async () => {",
    "    if (stopped) return;",
    "    try {",
    "      await fs.mkdir(liveDir, { recursive: true });",
    "      await page.screenshot({ path: path.join(liveDir, 'latest.png'), fullPage: true });",
    "    } catch {",
    "      // ignore screenshot failures",
    "    }",
    "  };",
    "  void capture();",
    "  const interval = setInterval(capture, 1500);",
    "  LIVE_PREVIEW_STOP.set(page, () => {",
    "    stopped = true;",
    "    clearInterval(interval);",
    "  });",
    "}",
    "",
    "test.beforeEach(async ({ page }) => {",
    "  attachPageSignals(page);",
    "  startLivePreview(page);",
    "});",
    "",
    "test.afterEach(async ({ page }, testInfo) => {",
    "  const stopLive = LIVE_PREVIEW_STOP.get(page);",
    "  if (stopLive) stopLive();",
    "  if (testInfo.status !== testInfo.expectedStatus) {",
    "    await writeSignals(page, testInfo);",
    "  }",
    "});",
    "",
    "type IdentityDescriptor =",
    "  | { kind: 'role'; role: string; name: string }",
    "  | { kind: 'text'; text: string }",
    "  | { kind: 'locator'; selector: string };",
    "",
    `const PAGE_IDENTITIES: Record<string, IdentityDescriptor> = ${JSON.stringify(pageIdentities, null, 2)};`,
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
    "    case 'text': {",
    "      const loc = page.getByText(identity.text);",
    "      if (await loc.count()) {",
    "        await expect(loc.first()).toBeVisible({ timeout: IDENTITY_CHECK_TIMEOUT });",
    "      } else {",
    "        await expect(page).toHaveTitle(new RegExp(escapeRegex(identity.text)), { timeout: IDENTITY_CHECK_TIMEOUT });",
    "      }",
    "      break;",
    "    }",
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
    "  return new RegExp(`^(?:https?:\\\\/\\\\/[^/]+)?${escaped}(?:$|[?#/])`);",
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




