import fs from 'node:fs/promises';
import path from 'node:path';
import { Locator, Page, TestInfo, test, expect } from '@playwright/test';

const BASE_URL = process.env.TM_BASE_URL ?? process.env.TEST_BASE_URL ?? process.env.BASE_URL ?? 'http://localhost:5173';
const RUN_LOG_DIR = process.env.TM_RUN_LOG_DIR || process.env.PW_OUTPUT_DIR;
const LIVE_PREVIEW_ENABLED = process.env.TM_LIVE_PREVIEW === '1';
const ACTION_SHOTS_ENABLED = process.env.TM_AI_ACTION_SHOTS !== '0';

type PageSignals = {
  url?: string;
  console: { type: string; text: string; location?: { url?: string; lineNumber?: number; columnNumber?: number } }[];
  pageErrors: string[];
  requestFailed: { url: string; errorText?: string }[];
  dom: { title?: string; h1?: string; bodyText?: string; htmlSnippet?: string };
};

const SIGNALS = new WeakMap<Page, PageSignals>();
const LIVE_PREVIEW_STOP = new WeakMap<Page, () => void>();
const STEP_CAPTURE_COUNT = new WeakMap<Page, number>();

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

function slugForFileName(input: string) {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'step';
}

async function captureStepArtifact(page: Page, testInfo: any, stepTitle: string) {
  if (!RUN_LOG_DIR || !ACTION_SHOTS_ENABLED) return;
  const nextCount = (STEP_CAPTURE_COUNT.get(page) ?? 0) + 1;
  STEP_CAPTURE_COUNT.set(page, nextCount);
  const ts = Date.now();
  const stepSlug = slugForFileName(stepTitle);
  const liveDir = path.join(RUN_LOG_DIR, 'live');
  const stepsDir = path.join(liveDir, 'steps');
  const name = `${String(nextCount).padStart(3, '0')}-${stepSlug}-${ts}.png`;
  const stepPath = path.join(stepsDir, name);
  const latestPath = path.join(liveDir, 'latest.png');
  try {
    await fs.mkdir(stepsDir, { recursive: true });
    await page.screenshot({ path: stepPath, fullPage: true });
    await fs.copyFile(stepPath, latestPath).catch(() => {});
    if (typeof testInfo?.attach === 'function') {
      await testInfo.attach(`step-${nextCount}-${stepSlug}`, {
        path: stepPath,
        contentType: 'image/png',
      });
    }
  } catch {
    // ignore per-step capture failures
  }
}

test.beforeEach(async ({ page }) => {
  attachPageSignals(page);
  STEP_CAPTURE_COUNT.set(page, 0);
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

type LocatorResolution = {
  candidates: string[];
  region?: Region;
  perCandidateTimeoutMs?: number;
  maxTotalResolveMs?: number;
};

type LocatorResolutionResult = {
  locator: Locator;
  attemptedSelectors: string[];
  selectedSelector: string;
  selectedIndex: number;
  resolveTimeMs: number;
};

async function findFirstWorkingLocator(page: Page, resolution: LocatorResolution): Promise<LocatorResolutionResult> {
  const attemptedSelectors = Array.from(new Set((resolution.candidates ?? []).map((v) => (v || '').trim()).filter(Boolean)));
  if (!attemptedSelectors.length) {
    throw new Error(JSON.stringify({ code: 'LOCATOR_RESOLUTION_FAILED', message: 'No locator candidates provided' }));
  }
  const perCandidateTimeoutMs = Math.max(200, Math.trunc(resolution.perCandidateTimeoutMs ?? 900));
  const maxTotalResolveMs = Math.max(perCandidateTimeoutMs, Math.trunc(resolution.maxTotalResolveMs ?? 2500));
  const startedAt = Date.now();
  const failures: string[] = [];
  for (let i = 0; i < attemptedSelectors.length; i++) {
    const selector = attemptedSelectors[i];
    const elapsed = Date.now() - startedAt;
    const remaining = maxTotalResolveMs - elapsed;
    if (remaining <= 0) break;
    const timeout = Math.max(150, Math.min(perCandidateTimeoutMs, remaining));
    const locator = chooseLocator(page, selector, resolution.region).first();
    try {
      await locator.waitFor({ state: 'visible', timeout });
      return {
        locator,
        attemptedSelectors,
        selectedSelector: selector,
        selectedIndex: i,
        resolveTimeMs: Date.now() - startedAt,
      };
    } catch (err) {
      failures.push(`${i}:${selector}:${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new Error(
    JSON.stringify({
      code: 'LOCATOR_RESOLUTION_FAILED',
      attemptedSelectors,
      selectedSelector: null,
      selectedIndex: -1,
      resolveTimeMs: Date.now() - startedAt,
      failures: failures.slice(0, 6),
    })
  );
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
  "usernameSelector": "input[name=\"email\"], input[type=\"email\"], input[autocomplete=\"username\"], input[name=\"username\"], #username, #email, input[placeholder*=\"email\" i]",
  "passwordSelector": "input[name=\"password\"], input[type=\"password\"], input[autocomplete=\"current-password\"], #password, input[placeholder*=\"password\" i]",
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
  const userLocator = page
  .locator(SHARED_LOGIN_CONFIG.usernameSelector)
  .or(page.getByLabel(/email|user(name)?/i))
  .or(page.getByPlaceholder(/email|user(name)?/i));
  await userLocator.first().waitFor({ state: 'visible', timeout: 30000 });
  await userLocator.first().fill(username);
  const passLocator = page
  .locator(SHARED_LOGIN_CONFIG.passwordSelector)
  .or(page.getByLabel(/password/i))
  .or(page.getByPlaceholder(/password/i));
  await passLocator.first().waitFor({ state: 'visible', timeout: 30000 });
  await passLocator.first().fill(password);
  if (SHARED_LOGIN_CONFIG.submitSelector) {
    const submit = page
  .locator(SHARED_LOGIN_CONFIG.submitSelector)
  .or(page.getByRole('button', { name: /log in|login|sign in|continue/i }));
    if (await submit.first().isVisible()) {
      await submit.first().click({ timeout: 10000 });
    }
  }
}

// Auto-generated for page /case-type-selection 6 test(s)

test("Page loads: /case-type-selection", async ({ page }, testInfo: TestInfo) => {
  test.info().annotations.push({ type: "parentSuite", description: "Testmind Generated Suite" }, { type: "suite", description: "/case-type-selection" }, { type: "story", description: "Page loads: /case-type-selection" }, { type: "parameter", description: "page=/case-type-selection" });
  await test.step("1. Navigate to https://www.justicepathlaw.com/case-type-selection", async () => {
    try {
    await navigateTo(page, "/case-type-selection");
      await ensurePageIdentity(page, "/case-type-selection");
    } finally {
      await captureStepArtifact(page, testInfo, "1. Navigate to https://www.justicepathlaw.com/case-type-selection");
    }
  });
  await test.step("2. Ensure text \"JusticePath — Accessible Legal Help\" is visible", async () => {
    try {
    {
      const rawText = "JusticePath — Accessible Legal Help";
      if (/justicepath/i.test(rawText) && "/case-type-selection" !== "/") {
        await ensurePageIdentity(page, "/case-type-selection");
        return;
      }
      if (rawText.trim().toLowerCase() === "page") {
        await expect(page).toHaveURL(pathRegex("/case-type-selection"), { timeout: 15000 });
        await ensurePageIdentity(page, "/case-type-selection");
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
    } finally {
      await captureStepArtifact(page, testInfo, "2. Ensure text \"JusticePath — Accessible Legal Help\" is visible");
    }
  });
});

test("Navigate /case-type-selection → /", async ({ page }, testInfo: TestInfo) => {
  test.info().annotations.push({ type: "parentSuite", description: "Testmind Generated Suite" }, { type: "suite", description: "/case-type-selection" }, { type: "story", description: "Navigate /case-type-selection → /" }, { type: "parameter", description: "page=/case-type-selection" });
  await test.step("1. Navigate to https://www.justicepathlaw.com/case-type-selection", async () => {
    try {
    await navigateTo(page, "/case-type-selection");
      await ensurePageIdentity(page, "/case-type-selection");
    } finally {
      await captureStepArtifact(page, testInfo, "1. Navigate to https://www.justicepathlaw.com/case-type-selection");
    }
  });
  await test.step("2. Navigate to /", async () => {
    try {
    await navigateTo(page, "/");
      await ensurePageIdentity(page, "/");
    } finally {
      await captureStepArtifact(page, testInfo, "2. Navigate to /");
    }
  });
  await test.step("3. Ensure text \"Page\" is visible", async () => {
    try {
    {
      const rawText = "Page";
      if (/justicepath/i.test(rawText) && "/case-type-selection" !== "/") {
        await ensurePageIdentity(page, "/case-type-selection");
        return;
      }
      if (rawText.trim().toLowerCase() === "page") {
        await expect(page).toHaveURL(pathRegex("/"), { timeout: 15000 });
        await ensurePageIdentity(page, "/");
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
    } finally {
      await captureStepArtifact(page, testInfo, "3. Ensure text \"Page\" is visible");
    }
  });
});

test("Navigate /case-type-selection → /live-chat", async ({ page }, testInfo: TestInfo) => {
  test.info().annotations.push({ type: "parentSuite", description: "Testmind Generated Suite" }, { type: "suite", description: "/case-type-selection" }, { type: "story", description: "Navigate /case-type-selection → /live-chat" }, { type: "parameter", description: "page=/case-type-selection" });
  await test.step("1. Navigate to https://www.justicepathlaw.com/case-type-selection", async () => {
    try {
    await navigateTo(page, "/case-type-selection");
      await ensurePageIdentity(page, "/case-type-selection");
    } finally {
      await captureStepArtifact(page, testInfo, "1. Navigate to https://www.justicepathlaw.com/case-type-selection");
    }
  });
  await test.step("2. Navigate to /live-chat", async () => {
    try {
    await navigateTo(page, "/live-chat");
      await ensurePageIdentity(page, "/live-chat");
    } finally {
      await captureStepArtifact(page, testInfo, "2. Navigate to /live-chat");
    }
  });
  await test.step("3. Ensure text \"live-chat\" is visible", async () => {
    try {
    {
      const rawText = "live-chat";
      if (/justicepath/i.test(rawText) && "/case-type-selection" !== "/") {
        await ensurePageIdentity(page, "/case-type-selection");
        return;
      }
      if (rawText.trim().toLowerCase() === "page") {
        await expect(page).toHaveURL(pathRegex("/case-type-selection"), { timeout: 15000 });
        await ensurePageIdentity(page, "/case-type-selection");
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
    } finally {
      await captureStepArtifact(page, testInfo, "3. Ensure text \"live-chat\" is visible");
    }
  });
});

test("Navigate /case-type-selection → /pricing", async ({ page }, testInfo: TestInfo) => {
  test.info().annotations.push({ type: "parentSuite", description: "Testmind Generated Suite" }, { type: "suite", description: "/case-type-selection" }, { type: "story", description: "Navigate /case-type-selection → /pricing" }, { type: "parameter", description: "page=/case-type-selection" });
  await test.step("1. Navigate to https://www.justicepathlaw.com/case-type-selection", async () => {
    try {
    await navigateTo(page, "/case-type-selection");
      await ensurePageIdentity(page, "/case-type-selection");
    } finally {
      await captureStepArtifact(page, testInfo, "1. Navigate to https://www.justicepathlaw.com/case-type-selection");
    }
  });
  await test.step("2. Navigate to /pricing", async () => {
    try {
    await navigateTo(page, "/pricing");
      await ensurePageIdentity(page, "/pricing");
    } finally {
      await captureStepArtifact(page, testInfo, "2. Navigate to /pricing");
    }
  });
  await test.step("3. Ensure text \"pricing\" is visible", async () => {
    try {
    {
      const rawText = "pricing";
      if (/justicepath/i.test(rawText) && "/case-type-selection" !== "/") {
        await ensurePageIdentity(page, "/case-type-selection");
        return;
      }
      if (rawText.trim().toLowerCase() === "page") {
        await expect(page).toHaveURL(pathRegex("/case-type-selection"), { timeout: 15000 });
        await ensurePageIdentity(page, "/case-type-selection");
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
    } finally {
      await captureStepArtifact(page, testInfo, "3. Ensure text \"pricing\" is visible");
    }
  });
});

test("Navigate /case-type-selection → /login", async ({ page }, testInfo: TestInfo) => {
  test.info().annotations.push({ type: "parentSuite", description: "Testmind Generated Suite" }, { type: "suite", description: "/case-type-selection" }, { type: "story", description: "Navigate /case-type-selection → /login" }, { type: "parameter", description: "page=/case-type-selection" });
  await test.step("1. Navigate to https://www.justicepathlaw.com/case-type-selection", async () => {
    try {
      await clickNavLink(page, "/case-type-selection");
    } finally {
      await captureStepArtifact(page, testInfo, "1. Navigate to https://www.justicepathlaw.com/case-type-selection");
    }
  });
  await expect(page).toHaveTitle(/JusticePath — Accessible Legal Help/, { timeout: 10000 });
  await test.step("2. Navigate to login", async () => {
    try {
      await clickNavLink(page, "/login");
      await expect(page).toHaveTitle(/JusticePath — Accessible Legal Help/, { timeout: 10000 });
      await expect(page).toHaveURL(/\/login/, { timeout: 10000 });
    } finally {
      await captureStepArtifact(page, testInfo, "2. Navigate to /login");
    }
  });
  await test.step("3. Verify URL is correct", async () => {
    try {
      await expect(page).toHaveURL(/\/login/, { timeout: 10000 });
    } finally {
      await captureStepArtifact(page, testInfo, "3. Verify URL");
    }
  });
});

test("Navigate /case-type-selection → /signup", async ({ page }, testInfo: TestInfo) => {
  test.info().annotations.push({ type: "parentSuite", description: "Testmind Generated Suite" }, { type: "suite", description: "/case-type-selection" }, { type: "story", description: "Navigate /case-type-selection → /signup" }, { type: "parameter", description: "page=/case-type-selection" });
  await test.step("1. Navigate to https://www.justicepathlaw.com/case-type-selection", async () => {
    try {
    await navigateTo(page, "/case-type-selection");
      await ensurePageIdentity(page, "/case-type-selection");
    } finally {
      await captureStepArtifact(page, testInfo, "1. Navigate to https://www.justicepathlaw.com/case-type-selection");
    }
  });
  await test.step("2. Navigate to /signup", async () => {
    try {
    await navigateTo(page, "/signup");
      await ensurePageIdentity(page, "/signup");
    } finally {
      await captureStepArtifact(page, testInfo, "2. Navigate to /signup");
    }
  });
  await test.step("3. Ensure text \"signup\" is visible", async () => {
    try {
    {
      const rawText = "signup";
      if (/justicepath/i.test(rawText) && "/case-type-selection" !== "/") {
        await ensurePageIdentity(page, "/case-type-selection");
        return;
      }
      if (rawText.trim().toLowerCase() === "page") {
        await expect(page).toHaveURL(pathRegex("/case-type-selection"), { timeout: 15000 });
        await ensurePageIdentity(page, "/case-type-selection");
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
    } finally {
      await captureStepArtifact(page, testInfo, "3. Ensure text \"signup\" is visible");
    }
  });
});
