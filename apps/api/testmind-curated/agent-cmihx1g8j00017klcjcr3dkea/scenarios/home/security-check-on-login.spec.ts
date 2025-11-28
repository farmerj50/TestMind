import { test, expect } from '@playwright/test';

// Auto-generated for page / – 1 test(s)

test("Security Check on Login", async ({ page }) => {
  test.info().annotations.push({ type: "parentSuite", description: "Testmind Generated Suite" }, { type: "suite", description: "/" }, { type: "story", description: "Security Check on Login" }, { type: "parameter", description: "page=/" });
  await test.step("1. Navigate to https://www.facebook.com/", async () => {
    await page.goto("https://www.facebook.com/");
  });
  await test.step("2. Click button:has-text(\"Log In\")", async () => {
    {
      const locator = page.locator("button:has-text(\"Log In\")");
      await locator.waitFor({ state: 'visible', timeout: 10000 });
      await locator.click({ timeout: 10000 });
    }
  });
});
