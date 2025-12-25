import { test, expect } from '@playwright/test';

// Auto-generated for page / – 1 test(s)

test("Test My Documents Button Functionality", async ({ page }) => {
  test.info().annotations.push({ type: "parentSuite", description: "Testmind Generated Suite" }, { type: "suite", description: "/" }, { type: "story", description: "Test My Documents Button Functionality" }, { type: "parameter", description: "page=/" });
  await test.step("1. Navigate to https://justicepathlaw.com/", async () => {
    await page.goto("https://justicepathlaw.com/");
  });
  await test.step("2. Click button:has-text(\"My Documents\")", async () => {
    {
      const locator = page.locator("button:has-text(\"My Documents\")");
      await locator.waitFor({ state: 'visible', timeout: 10000 });
      await locator.click({ timeout: 10000 });
    }
  });
});
