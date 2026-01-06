import { test, expect } from '@playwright/test';

// Auto-generated for page / – 1 test(s)

test("Successful Sign Up with Valid Data", async ({ page }) => {
  test.info().annotations.push({ type: "parentSuite", description: "Testmind Generated Suite" }, { type: "suite", description: "/" }, { type: "story", description: "Successful Sign Up with Valid Data" }, { type: "parameter", description: "page=/" });
  await test.step("1. Navigate to https://www.facebook.com/", async () => {
    await page.goto("https://www.facebook.com/");
  });
  await test.step("2. Click button:has-text(\"Create new account\")", async () => {
    {
      const locator = page.locator("button:has-text(\"Create new account\")");
      await locator.waitFor({ state: 'visible', timeout: 10000 });
      await locator.click({ timeout: 10000 });
    }
  });
});
