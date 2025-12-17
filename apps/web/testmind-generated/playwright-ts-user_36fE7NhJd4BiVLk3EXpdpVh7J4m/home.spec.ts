import { Page, test, expect } from '@playwright/test';

const BASE_URL = process.env.BASE_URL ?? 'https://justicepathlaw.com';

type IdentityDescriptor =
  | { kind: 'role'; role: string; name: string }
  | { kind: 'text'; text: string }
  | { kind: 'locator'; selector: string };

const PAGE_IDENTITIES: Record<string, IdentityDescriptor> = {
  '/': { kind: 'role', role: 'heading', name: 'Accessible Legal Help for Everyone' },
  '/login': { kind: 'role', role: 'heading', name: 'Login' },
  '/signup': { kind: 'role', role: 'heading', name: 'Sign Up' },
  '/case-type-selection': { kind: 'text', text: "Select the type of legal issue you're dealing with:" },
  '/pricing': { kind: 'role', role: 'heading', name: 'Choose Your Plan' },
};

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
  let identity = PAGE_IDENTITIES[normalized];
  if (!identity) {
    const withoutQuery = normalized.split('?')[0] || normalized;
    identity = PAGE_IDENTITIES[withoutQuery];
  }
  if (!identity) return;
  switch (identity.kind) {
    case 'role':
      await expect(page.getByRole(identity.role, { name: identity.name })).toBeVisible({ timeout: IDENTITY_CHECK_TIMEOUT });
      break;
    case 'text':
      await expect(page.getByText(identity.text)).toBeVisible({ timeout: IDENTITY_CHECK_TIMEOUT });
      break;
    case 'locator': {
      const locator = page.locator(identity.selector);
      await locator.waitFor({ state: 'visible', timeout: IDENTITY_CHECK_TIMEOUT });
      await expect(locator).toBeVisible({ timeout: IDENTITY_CHECK_TIMEOUT });
      break;
    }
  }
}

const SHARED_LOGIN_CONFIG = {
  "usernameSelector": "input[placeholder=\"Email Address\"], input[name=\"email\"], input[type=\"email\"], input[name=\"username\"], #username, #email",
  "passwordSelector": "input[placeholder=\"Password\"], input[name=\"password\"], input[type=\"password\"], #password",
  "submitSelector": "button[type=\"submit\"], button:has-text(\"Login\"), button:has-text(\"Sign in\")",
  "usernameEnv": "USERNAME",
  "passwordEnv": "PASSWORD"
};

async function navigateTo(page: Page, target: string) {
  const url = new URL(target, BASE_URL);
  await page.goto(url.toString(), { waitUntil: 'domcontentloaded' });
  await expect(page).toHaveURL(url.toString());
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

// Auto-generated for page / – 7 test(s)

test("Page loads: /", async ({ page }) => {
  test.info().annotations.push({ type: "parentSuite", description: "Testmind Generated Suite" }, { type: "suite", description: "/" }, { type: "story", description: "Page loads: /" }, { type: "parameter", description: "page=/" });
  await test.step("1. Navigate to https://justicepathlaw.com/", async () => {
    await navigateTo(page, "/");
      await ensurePageIdentity(page, "/");
  });
  await test.step("2. Ensure text \"JusticePath — Accessible Legal Help\" is visible", async () => {
    await expect(page.getByText("JusticePath — Accessible Legal Help")).toBeVisible({ timeout: 10000 });
  });
});

test("Navigate / → /live-chat", async ({ page }) => {
  test.info().annotations.push({ type: "parentSuite", description: "Testmind Generated Suite" }, { type: "suite", description: "/" }, { type: "story", description: "Navigate / → /live-chat" }, { type: "parameter", description: "page=/" });
  await test.step("1. Navigate to https://justicepathlaw.com/", async () => {
    await navigateTo(page, "/");
      await ensurePageIdentity(page, "/");
  });
  await test.step("2. Navigate to /live-chat", async () => {
    await navigateTo(page, "/live-chat");
      await ensurePageIdentity(page, "/live-chat");
  });
  await test.step("3. Ensure text \"live-chat\" is visible", async () => {
    await expect(page.getByText("live-chat")).toBeVisible({ timeout: 10000 });
  });
});

test("Navigate / → /pricing", async ({ page }) => {
  test.info().annotations.push({ type: "parentSuite", description: "Testmind Generated Suite" }, { type: "suite", description: "/" }, { type: "story", description: "Navigate / → /pricing" }, { type: "parameter", description: "page=/" });
  await test.step("1. Navigate to https://justicepathlaw.com/", async () => {
    await navigateTo(page, "/");
      await ensurePageIdentity(page, "/");
  });
  await test.step("2. Navigate to /pricing", async () => {
    await navigateTo(page, "/pricing");
      await ensurePageIdentity(page, "/pricing");
  });
  await test.step("3. Ensure text \"pricing\" is visible", async () => {
    await expect(page.getByText("pricing")).toBeVisible({ timeout: 10000 });
  });
});

test("Navigate / → /login", async ({ page }) => {
  test.info().annotations.push({ type: "parentSuite", description: "Testmind Generated Suite" }, { type: "suite", description: "/" }, { type: "story", description: "Navigate / → /login" }, { type: "parameter", description: "page=/" });
  await test.step("1. Navigate to https://justicepathlaw.com/", async () => {
    await navigateTo(page, "/");
      await ensurePageIdentity(page, "/");
  });
  await sharedLogin(page);
  await test.step("2. Navigate to /login", async () => {
    await navigateTo(page, "/login");
      await ensurePageIdentity(page, "/login");
  });
  await test.step("3. Ensure text \"login\" is visible", async () => {
    await expect(page.getByText("login")).toBeVisible({ timeout: 10000 });
  });
});

test("Navigate / → /signup", async ({ page }) => {
  test.info().annotations.push({ type: "parentSuite", description: "Testmind Generated Suite" }, { type: "suite", description: "/" }, { type: "story", description: "Navigate / → /signup" }, { type: "parameter", description: "page=/" });
  await test.step("1. Navigate to https://justicepathlaw.com/", async () => {
    await navigateTo(page, "/");
      await ensurePageIdentity(page, "/");
  });
  await test.step("2. Navigate to /signup", async () => {
    await navigateTo(page, "/signup");
      await ensurePageIdentity(page, "/signup");
  });
  await test.step("3. Ensure text \"signup\" is visible", async () => {
    await expect(page.getByText("signup")).toBeVisible({ timeout: 10000 });
  });
});

test("Navigate / → /select-plan", async ({ page }) => {
  test.info().annotations.push({ type: "parentSuite", description: "Testmind Generated Suite" }, { type: "suite", description: "/" }, { type: "story", description: "Navigate / → /select-plan" }, { type: "parameter", description: "page=/" });
  await test.step("1. Navigate to https://justicepathlaw.com/", async () => {
    await navigateTo(page, "/");
      await ensurePageIdentity(page, "/");
  });
  await test.step("2. Navigate to /select-plan", async () => {
    await navigateTo(page, "/select-plan");
      await ensurePageIdentity(page, "/select-plan");
  });
  await test.step("3. Ensure text \"select-plan\" is visible", async () => {
    await expect(page.getByText("select-plan")).toBeVisible({ timeout: 10000 });
  });
});

test("Navigate / → /case-type-selection", async ({ page }) => {
  test.info().annotations.push({ type: "parentSuite", description: "Testmind Generated Suite" }, { type: "suite", description: "/" }, { type: "story", description: "Navigate / → /case-type-selection" }, { type: "parameter", description: "page=/" });
  await test.step("1. Navigate to https://justicepathlaw.com/", async () => {
    await navigateTo(page, "/");
      await ensurePageIdentity(page, "/");
  });
  await test.step("2. Navigate to /case-type-selection", async () => {
    await navigateTo(page, "/case-type-selection");
      await ensurePageIdentity(page, "/case-type-selection");
  });
  await test.step("3. Ensure text \"case-type-selection\" is visible", async () => {
    await expect(page.getByText("case-type-selection")).toBeVisible({ timeout: 10000 });
  });
});
