import fs from 'node:fs/promises';
import path from 'node:path';
import { Page, test, expect } from '@playwright/test';

const BASE_URL = process.env.TM_BASE_URL ?? process.env.TEST_BASE_URL ?? process.env.BASE_URL ?? 'http://localhost:5173';
const RUN_LOG_DIR = process.env.TM_RUN_LOG_DIR || process.env.PW_OUTPUT_DIR;
const LIVE_PREVIEW_ENABLED = process.env.TM_LIVE_PREVIEW === '1';

type PageSignals = {
  url?: string;
  console: { type: string; text: string; location?: { url?: string; lineNumber?: number; columnNumber?: number } }[];
  pageErrors: string[];
  requestFailed: { url: string; errorText?: string }[];
  dom: { title?: string; h1?: string; bodyText?: string; htmlSnippet?: string };
};

const SIGNALS = new WeakMap<Page, PageSignals>();
const LIVE_PREVIEW_STOP = new WeakMap<Page, () => void>();

function attachPageSignals(page: Page): PageSignals {
  const signals: PageSignals = { console: [], pageErrors: [], requestFailed: [], dom: {} };
  page.on('console', (msg) => {
    signals.console.push({
      type: msg.type(),
      text: msg.text().slice(0, 500),
      location: msg.location?.(),
    });
  });
  page.on('pageerror', (err) => signals.pageErrors.push(String(err).slice(0, 800)));
  page.on('requestfailed', (req) => {
    signals.requestFailed.push({ url: req.url(), errorText: req.failure()?.errorText });
  });
  SIGNALS.set(page, signals);
  return signals;
}

async function snapshotSignals(page: Page, signals: PageSignals) {
  try {
    signals.url = page.url();
    signals.dom.title = await page.title().catch(() => undefined);
    signals.dom.h1 = await page.locator('h1').first().innerText().catch(() => undefined);
    signals.dom.bodyText = (await page.locator('body').innerText().catch(() => '')).slice(0, 2000);
    signals.dom.htmlSnippet = (await page.content().catch(() => '')).slice(0, 2000);
  } catch {
    // ignore snapshot failures
  }
}

async function writeSignals(page: Page, testInfo: any) {
  if (!RUN_LOG_DIR) return;
  const signals = SIGNALS.get(page) ?? attachPageSignals(page);
  await snapshotSignals(page, signals);
  const payload = {
    title: testInfo.title,
    status: testInfo.status,
    expectedStatus: testInfo.expectedStatus,
    file: testInfo.file,
    line: testInfo.line,
    signals,
  };
  await fs.mkdir(RUN_LOG_DIR, { recursive: true });
  await fs.writeFile(path.join(RUN_LOG_DIR, 'page-signals.json'), JSON.stringify(payload, null, 2));
}

function startLivePreview(page: Page) {
  if (!LIVE_PREVIEW_ENABLED || !RUN_LOG_DIR) return;
  const liveDir = path.join(RUN_LOG_DIR, 'live');
  let stopped = false;
  const capture = async () => {
    if (stopped) return;
    try {
      await fs.mkdir(liveDir, { recursive: true });
      await page.screenshot({ path: path.join(liveDir, 'latest.png'), fullPage: true });
    } catch {
      // ignore screenshot failures
    }
  };
  void capture();
  const interval = setInterval(capture, 1500);
  LIVE_PREVIEW_STOP.set(page, () => {
    stopped = true;
    clearInterval(interval);
  });
}

test.beforeEach(async ({ page }) => {
  attachPageSignals(page);
  startLivePreview(page);
});

test.afterEach(async ({ page }, testInfo) => {
  const stopLive = LIVE_PREVIEW_STOP.get(page);
  if (stopLive) stopLive();
  if (testInfo.status !== testInfo.expectedStatus) {
    await writeSignals(page, testInfo);
  }
});

type IdentityDescriptor =
  | { kind: 'role'; role: string; name: string }
  | { kind: 'text'; text: string }
  | { kind: 'locator'; selector: string };

const PAGE_IDENTITIES: Record<string, IdentityDescriptor> = {};

const IDENTITY_CHECK_TIMEOUT = 10000;

function normalizeIdentityPath(target: string): string {
  if (!target) return '/';
  try {
    const parsed = new URL(target, BASE_URL);
    const path = parsed.pathname || '/';
    const search = parsed.search || '';
    return `${path}${search}` || '/';
  } catch {
    if (target.startsWith('/')) return target;
    return `/${target}`;
  }
}

async function ensurePageIdentity(page: Page, target: string) {
  const normalized = normalizeIdentityPath(target);
  const withoutQuery = normalized.split('?')[0] || normalized;
  let identity = PAGE_IDENTITIES[normalized] ?? PAGE_IDENTITIES[withoutQuery];
  if (!identity) {
    const candidates = Object.entries(PAGE_IDENTITIES).filter(([route]) =>
      matchesIdentityPrefix(withoutQuery, route)
    );
    if (candidates.length) {
      identity = candidates.sort((a, b) => b[0].length - a[0].length)[0][1];
    }
  }
  if (!identity) return;
  switch (identity.kind) {
    case 'role':
      await expect(
        page.getByRole(identity.role, { name: identity.name })
      ).toBeVisible({ timeout: IDENTITY_CHECK_TIMEOUT });
      break;
    case 'text': {
      const loc = page.getByText(identity.text);
      if (await loc.count()) {
        await expect(loc.first()).toBeVisible({ timeout: IDENTITY_CHECK_TIMEOUT });
      } else {
        await expect(page).toHaveTitle(new RegExp(escapeRegex(identity.text)), { timeout: IDENTITY_CHECK_TIMEOUT });
      }
      break;
    }
    case 'locator': {
      const locator = page.locator(identity.selector);
      await locator.waitFor({ state: 'visible', timeout: IDENTITY_CHECK_TIMEOUT });
      await expect(locator).toBeVisible({ timeout: IDENTITY_CHECK_TIMEOUT });
      break;
    }
  }
}

function matchesIdentityPrefix(route: string, prefix: string): boolean {
  const normalizedPrefix = prefix || '/';
  if (normalizedPrefix === '/') {
    return route === '/';
  }
  if (route === normalizedPrefix) {
    return true;
  }
  const prefixWithSlash = normalizedPrefix.endsWith('/') ? normalizedPrefix : `${normalizedPrefix}/`;
  return route.startsWith(prefixWithSlash);
}

type Region = 'navigation' | 'header' | 'main';

function getAttributeValue(selector: string, attr: string): string | undefined {
  const regex = new RegExp(`${attr}\s*=\s*['"]([^'"]+)['"]`, 'i');
  const match = selector.match(regex);
  return match ? match[1] : undefined;
}

function regionScope(page: Page, region?: Region) {
  switch (region) {
    case 'navigation':
      return page.getByRole('navigation');
    case 'header':
      return page.locator('header');
    case 'main':
      return page.locator('main');
    default:
      return page;
  }
}

function chooseLocator(page: Page, selector: string, region?: Region) {
  const scope = regionScope(page, region);
  const testId = getAttributeValue(selector, 'data-testid');
  if (testId) {
    return scope.getByTestId(testId);
  }
  const role = getAttributeValue(selector, 'role');
  if (role) {
    const name = getAttributeValue(selector, 'name');
    return scope.getByRole(role, name ? { name } : undefined);
  }
  return scope.locator(selector);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function pathRegex(target: string): RegExp {
  const escaped = escapeRegex(target);
  return new RegExp(`^(?:https?:\\/\\/[^/]+)?${escaped}(?:$|[?#/])`);
}

function identityPathForText(text?: string): string | undefined {
  if (!text) return undefined;
  const normalized = text.trim().toLowerCase();
  if (!normalized) return undefined;
  for (const [path, identity] of Object.entries(PAGE_IDENTITIES)) {
    if (identity.kind === 'role' && identity.name?.toLowerCase() === normalized) {
      return path;
    }
    if (identity.kind === 'text' && identity.text?.toLowerCase().includes(normalized)) {
      return path;
    }
  }
  return undefined;
}

async function clickNavLink(page: Page, target: string): Promise<void> {
  const normalizedPath = normalizeIdentityPath(target);
  const targetSelector = `a[href="${normalizedPath}"]`;
  const scopes = [
    page.getByRole('navigation'),
    page.locator('header'),
    page.locator('main'),
  ];
  for (const scope of scopes) {
    const link = scope.locator(targetSelector);
    if (await link.count()) {
      const candidate = link.first();
      await candidate.waitFor({ state: 'visible', timeout: 15000 });
      await candidate.click({ timeout: 15000 });
      return;
    }
  }
  const fallback = page.locator(targetSelector).first();
  await fallback.waitFor({ state: 'visible', timeout: 15000 });
  await fallback.click({ timeout: 15000 });
}

const SHARED_LOGIN_CONFIG = {
  "usernameSelector": "input[placeholder=\"Email Address\"], input[name=\"email\"], input[type=\"email\"], input[name=\"username\"], #username, #email",
  "passwordSelector": "input[placeholder=\"Password\"], input[name=\"password\"], input[type=\"password\"], #password",
  "submitSelector": "button[type=\"submit\"], button:has-text(\"Login\"), button:has-text(\"Sign in\")",
  "usernameEnv": "EMAIL_ADDRESS",
  "passwordEnv": "PASSWORD"
};

async function navigateTo(page: Page, target: string) {
  const url = new URL(target, BASE_URL);
  await page.goto(url.toString(), { waitUntil: 'domcontentloaded' });
  await assertNavigationPath(page, url);
}

async function assertNavigationPath(page: Page, expectedUrl: URL) {
  const currentUrl = new URL(await page.url());
  const expectedPath = expectedUrl.pathname || '/';
  if (currentUrl.origin !== expectedUrl.origin) {
    throw new Error(`Expected origin ${expectedUrl.origin} but saw ${currentUrl.origin}`);
  }
  if (expectedPath === '/') {
    if (currentUrl.pathname !== '/') {
      throw new Error(`Expected pathname / but saw ${currentUrl.pathname}`);
    }
    return;
  }
  if (currentUrl.pathname === expectedPath) {
    return;
  }
  const expectedWithSlash = expectedPath.endsWith('/') ? expectedPath : `${expectedPath}/`;
  if (!currentUrl.pathname.startsWith(expectedWithSlash)) {
    throw new Error(`Expected pathname to start with ${expectedPath} but saw ${currentUrl.pathname}`);
  }
}

async function sharedLogin(page: Page) {
  const usernameEnv = SHARED_LOGIN_CONFIG.usernameEnv;
  const passwordEnv = SHARED_LOGIN_CONFIG.passwordEnv;
  const envUsername = process.env[usernameEnv] ?? process.env.EMAIL ?? '';
  const envPassword = process.env[passwordEnv] ?? process.env.PASSWORD ?? '';
  const username = SHARED_LOGIN_CONFIG.usernameValue ?? envUsername;
  const password = SHARED_LOGIN_CONFIG.passwordValue ?? envPassword;
  const userLocator = page.locator(SHARED_LOGIN_CONFIG.usernameSelector);
  await userLocator.first().waitFor({ state: 'visible', timeout: 30000 });
  await userLocator.first().fill(username);
  const passLocator = page.locator(SHARED_LOGIN_CONFIG.passwordSelector);
  await passLocator.first().waitFor({ state: 'visible', timeout: 30000 });
  await passLocator.first().fill(password);
  if (SHARED_LOGIN_CONFIG.submitSelector) {
    const submit = page.locator(SHARED_LOGIN_CONFIG.submitSelector);
    if (await submit.first().isVisible()) {
      await submit.first().click({ timeout: 10000 });
    }
  }
}

// Auto-generated for page /manual/smoke-landing-page 1 test(s)

test("Smoke | Landing page", async ({ page }) => {
  test.info().annotations.push({ type: "parentSuite", description: "Testmind Generated Suite" }, { type: "suite", description: "/manual/smoke-landing-page" }, { type: "story", description: "Smoke | Landing page" }, { type: "parameter", description: "page=/manual/smoke-landing-page" });
  await test.step("1. Ensure text \"Review Landing page\" is visible", async () => {
    {
      const rawText = "Review Landing page";
      if (/justicepath/i.test(rawText) && "/manual/smoke-landing-page" !== "/") {
        await ensurePageIdentity(page, "/manual/smoke-landing-page");
        return;
      }
      if (rawText.trim().toLowerCase() === "page") {
        await expect(page).toHaveURL(pathRegex("/manual/smoke-landing-page"), { timeout: 15000 });
        await ensurePageIdentity(page, "/manual/smoke-landing-page");
        return;
      }
      const normalized = rawText.trim().toLowerCase();
      const routeCandidate = normalized.startsWith("/") ? normalized : `/${normalized}`;
      const routeLike = /^[a-z0-9\-/]+$/.test(normalized) && normalized !== "page";
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
    }
  });
  await test.step("2. Navigate to /through happy path login and dashboard", async () => {
    await navigateTo(page, "/through happy path login and dashboard");
      await ensurePageIdentity(page, "/through happy path login and dashboard");
  });
  await test.step("3. Ensure text \"Validate behavior expectations\" is visible", async () => {
    {
      const rawText = "Validate behavior expectations";
      if (/justicepath/i.test(rawText) && "/manual/smoke-landing-page" !== "/") {
        await ensurePageIdentity(page, "/manual/smoke-landing-page");
        return;
      }
      if (rawText.trim().toLowerCase() === "page") {
        await expect(page).toHaveURL(pathRegex("/manual/smoke-landing-page"), { timeout: 15000 });
        await ensurePageIdentity(page, "/manual/smoke-landing-page");
        return;
      }
      const normalized = rawText.trim().toLowerCase();
      const routeCandidate = normalized.startsWith("/") ? normalized : `/${normalized}`;
      const routeLike = /^[a-z0-9\-/]+$/.test(normalized) && normalized !== "page";
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
    }
  });
});
