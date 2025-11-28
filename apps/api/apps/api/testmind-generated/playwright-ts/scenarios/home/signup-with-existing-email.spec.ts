import { test, expect } from '@playwright/test';

// Auto-generated for page / – 1 test(s)

test("Signup with Existing Email", async ({ page }) => {
  test.info().annotations.push({ type: "parentSuite", description: "Testmind Generated Suite" }, { type: "suite", description: "/" }, { type: "story", description: "Signup with Existing Email" }, { type: "parameter", description: "page=/" });
  await test.step("1. Navigate to https://www.facebook.com/", async () => {
    await page.goto("https://www.facebook.com/");
  });
  await test.step("2. Click button:has-text(\"Create new account\")", async () => {
    {
      const locator = page.locator("button:has-text(\"Create new account\")");
      await locator.waitFor({ state: 'visible', timeout: 15000 });  // Increased timeout
      await locator.click({ timeout: 30000 });
    }
  });
});