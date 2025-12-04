import { test, expect } from '@playwright/test';

// Auto-generated for page / – 1 test(s)

test("Successful Account Creation", async ({ page }) => {
  test.info().annotations.push({ type: "parentSuite", description: "Testmind Generated Suite" }, { type: "suite", description: "/" }, { type: "story", description: "Successful Account Creation" }, { type: "parameter", description: "page=/" });
  await test.step("1. Navigate to https://www.facebook.com/", async () => {
    await page.goto("https://www.facebook.com/", { timeout: 30000 });
  });
  await test.step("2. Click button:has-text(\"Create new account\")", async () => {
    const locator = page.locator("button:has-text(\"Create new account\")");
    await locator.waitFor({ state: 'visible', timeout: 30000 });
    await locator.click({ timeout: 30000 });
  });
});