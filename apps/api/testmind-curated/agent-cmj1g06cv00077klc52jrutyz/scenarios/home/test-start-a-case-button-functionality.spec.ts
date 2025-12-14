import { test, expect } from '@playwright/test';

// Auto-generated for page / – 1 test(s)

test("Test Start a Case Button Functionality", async ({ page }) => {
  test.info().annotations.push({ type: "parentSuite", description: "Testmind Generated Suite" }, { type: "suite", description: "/" }, { type: "story", description: "Test Start a Case Button Functionality" }, { type: "parameter", description: "page=/" });
  await test.step("1. Navigate to https://justicepathlaw.com/", async () => {
    await page.goto("https://justicepathlaw.com/");
  });
  await test.step("2. Click button:has-text(\"Start a Case\")", async () => {
    {
      const locator = page.locator("button:has-text(\"Start a Case\")");
      await locator.waitFor({ state: 'visible', timeout: 10000 });
      await locator.click({ timeout: 10000 });
    }
  });
});
