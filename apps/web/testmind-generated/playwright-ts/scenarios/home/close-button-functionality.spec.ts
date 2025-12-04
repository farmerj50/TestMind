import { test, expect } from '@playwright/test';

// Auto-generated for page / – 1 test(s)

test("Close Button Functionality", async ({ page }) => {
  test.info().annotations.push({ type: "parentSuite", description: "Testmind Generated Suite" }, { type: "suite", description: "/" }, { type: "story", description: "Close Button Functionality" }, { type: "parameter", description: "page=/" });
  await test.step("1. Navigate to https://bovada.lv/", async () => {
    await page.goto("https://bovada.lv/");
  });
  await test.step("2. Click button:has-text(\"×\")", async () => {
    {
      const locator = page.locator("button:has-text(\"×\")");
      await locator.waitFor({ state: 'visible', timeout: 10000 });
      await locator.click({ timeout: 10000 });
    }
  });
});
