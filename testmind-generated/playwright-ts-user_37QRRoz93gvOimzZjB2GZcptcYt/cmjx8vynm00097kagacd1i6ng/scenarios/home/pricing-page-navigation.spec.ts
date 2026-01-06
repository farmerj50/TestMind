import { test, expect } from '@playwright/test';

// Auto-generated for page / – 1 test(s)

test("Pricing Page Navigation", async ({ page }) => {
  test.info().annotations.push({ type: "parentSuite", description: "Testmind Generated Suite" }, { type: "suite", description: "/" }, { type: "story", description: "Pricing Page Navigation" }, { type: "parameter", description: "page=/" });
  await test.step("1. Navigate to http://localhost:5173/", async () => {
    await page.goto("http://localhost:5173/");
  });
  await test.step("2. Click link", async () => {
    {
      const locator = page.locator("link");
      await locator.waitFor({ state: 'visible', timeout: 10000 });
      await locator.click({ timeout: 10000 });
    }
  });
});
