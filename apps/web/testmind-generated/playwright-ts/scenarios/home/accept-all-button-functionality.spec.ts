import { test, expect } from '@playwright/test';

// Auto-generated for page / – 1 test(s)

test("Accept All Button Functionality", async ({ page }) => {
  test.info().annotations.push({ type: "parentSuite", description: "Testmind Generated Suite" }, { type: "suite", description: "/" }, { type: "story", description: "Accept All Button Functionality" }, { type: "parameter", description: "page=/" });
  await test.step("1. Navigate to https://bovada.lv/", async () => {
    await page.goto("https://bovada.lv/");
  });
  await test.step("2. Click button:has-text(\"Accept all\")", async () => {
    {
      // Be explicit to avoid strict-mode collisions when multiple “Accept all” buttons exist.
      const locator = page.locator('button.coi-banner__accept:has-text("Accept all")').first();
      await locator.waitFor({ state: 'visible', timeout: 10000 });
      await locator.click({ timeout: 10000 });
    }
  });
});
