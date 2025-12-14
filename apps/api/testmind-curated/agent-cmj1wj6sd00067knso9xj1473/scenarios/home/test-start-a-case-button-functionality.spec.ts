import { Page, test, expect } from '@playwright/test';

const BASE_URL = process.env.BASE_URL ?? 'https://justicepathlaw.com';

const SHARED_LOGIN_CONFIG = {
  "usernameSelector": "input[name=\"username\"], input[name=\"email\"], #username, #email",
  "passwordSelector": "input[name=\"password\"], #password",
  "submitSelector": "button[type=\"submit\"], button:has-text(\"Login\"), button:has-text(\"Sign in\")",
  "usernameEnv": "USERNAME",
  "passwordEnv": "PASSWORD"
};

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

// Auto-generated for page / – 1 test(s)

test("Test Start a Case Button Functionality", async ({ page }) => {
  test.info().annotations.push({ type: "parentSuite", description: "Testmind Generated Suite" }, { type: "suite", description: "/" }, { type: "story", description: "Test Start a Case Button Functionality" }, { type: "parameter", description: "page=/" });
  await test.step("1. Navigate to https://justicepathlaw.com/", async () => {
    await navigateTo(page, "/");
  });
  await test.step("2. Click button", async () => {
    {
      const locator = page.locator("button");
      await locator.waitFor({ state: 'visible', timeout: 10000 });
      await locator.click({ timeout: 10000 });
    }
  });
});
