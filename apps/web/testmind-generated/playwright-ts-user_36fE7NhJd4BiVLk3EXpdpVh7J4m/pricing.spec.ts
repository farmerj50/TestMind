import { Page, test, expect } from '@playwright/test';

const BASE_URL = process.env.BASE_URL ?? 'https://justicepathlaw.com';

function escapeForRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&');
}

async function navigateTo(page: Page, target: string) {
  const url = new URL(target, BASE_URL);
  await page.goto(url.toString(), { waitUntil: 'domcontentloaded' });
  if (target.startsWith('/')) {
    const pathRe = target === '/' ? '/?' : `${target}/?`;
    await expect(page).toHaveURL(new RegExp(`^(https?:\\/\\/[^/]+)?${escapeForRegex(pathRe)}(?:\\?.*)?$`));
  } else {
    await expect(page).toHaveURL(target);
  }
}

async function sharedLogin(page: Page) {
  const username = process.env.USERNAME || process.env.EMAIL;
  const password = process.env.PASSWORD;
  const userLocator = page.locator('input[name="username"], input[name="email"], #username, #email');
  const passLocator = page.locator('input[name="password"], #password');
  await userLocator.first().waitFor({ state: 'visible', timeout: 30000 });
  await userLocator.first().fill(username || '');
  await passLocator.first().waitFor({ state: 'visible', timeout: 30000 });
  await passLocator.first().fill(password || '');
  const submit = page.locator('button[type="submit"], button:has-text("Login"), button:has-text("Sign in")');
  if (await submit.first().isVisible()) {
    await submit.first().click({ timeout: 10000 });
  }
}

// Auto-generated for page /pricing – 5 test(s)

test("Page loads: /pricing", async ({ page }) => {
  test.info().annotations.push({ type: "parentSuite", description: "Testmind Generated Suite" }, { type: "suite", description: "/pricing" }, { type: "story", description: "Page loads: /pricing" }, { type: "parameter", description: "page=/pricing" });
  await test.step("1. Navigate to https://justicepathlaw.com/pricing", async () => {
    await navigateTo(page, "/pricing");
  });
  await test.step("2. Ensure text \"JusticePath — Accessible Legal Help\" is visible", async () => {
    await expect(page.getByText("JusticePath — Accessible Legal Help")).toBeVisible({ timeout: 10000 });
  });
});

test("Navigate /pricing → /", async ({ page }) => {
  test.info().annotations.push({ type: "parentSuite", description: "Testmind Generated Suite" }, { type: "suite", description: "/pricing" }, { type: "story", description: "Navigate /pricing → /" }, { type: "parameter", description: "page=/pricing" });
  await test.step("1. Navigate to https://justicepathlaw.com/pricing", async () => {
    await navigateTo(page, "/pricing");
  });
  await test.step("2. Navigate to /", async () => {
    await navigateTo(page, "/");
  });
  await test.step("3. Ensure text \"Page\" is visible", async () => {
    await expect(page.getByText("Page")).toBeVisible({ timeout: 10000 });
  });
});

test("Navigate /pricing → /live-chat", async ({ page }) => {
  test.info().annotations.push({ type: "parentSuite", description: "Testmind Generated Suite" }, { type: "suite", description: "/pricing" }, { type: "story", description: "Navigate /pricing → /live-chat" }, { type: "parameter", description: "page=/pricing" });
  await test.step("1. Navigate to https://justicepathlaw.com/pricing", async () => {
    await navigateTo(page, "/pricing");
  });
  await test.step("2. Navigate to /live-chat", async () => {
    await navigateTo(page, "/live-chat");
  });
  await test.step("3. Ensure text \"live-chat\" is visible", async () => {
    await expect(page.getByText("live-chat")).toBeVisible({ timeout: 10000 });
  });
});

test("Navigate /pricing → /login", async ({ page }) => {
  test.info().annotations.push({ type: "parentSuite", description: "Testmind Generated Suite" }, { type: "suite", description: "/pricing" }, { type: "story", description: "Navigate /pricing → /login" }, { type: "parameter", description: "page=/pricing" });
  await test.step("1. Navigate to https://justicepathlaw.com/pricing", async () => {
    await navigateTo(page, "/pricing");
  });
  await sharedLogin(page);
  await test.step("2. Navigate to /login", async () => {
    await navigateTo(page, "/login");
  });
  await test.step("3. Ensure text \"login\" is visible", async () => {
    await expect(page.getByText("login")).toBeVisible({ timeout: 10000 });
  });
});

test("Navigate /pricing → /signup", async ({ page }) => {
  test.info().annotations.push({ type: "parentSuite", description: "Testmind Generated Suite" }, { type: "suite", description: "/pricing" }, { type: "story", description: "Navigate /pricing → /signup" }, { type: "parameter", description: "page=/pricing" });
  await test.step("1. Navigate to https://justicepathlaw.com/pricing", async () => {
    await navigateTo(page, "/pricing");
  });
  await test.step("2. Navigate to /signup", async () => {
    await navigateTo(page, "/signup");
  });
  await test.step("3. Ensure text \"signup\" is visible", async () => {
    await expect(page.getByText("signup")).toBeVisible({ timeout: 10000 });
  });
});
