import { test, expect } from '@playwright/test';

// Auto-generated for page / – 1 test(s)

test("Successful Sign Up with Valid Data", async ({ page }) => {
  test.info().annotations.push({ type: "parentSuite", description: "Testmind Generated Suite" }, { type: "suite", description: "/" }, { type: "story", description: "Successful Sign Up with Valid Data" }, { type: "parameter", description: "page=/'" });
  await test.step("1. Navigate to https://www.facebook.com/", async () => {
    await page.goto("https://www.facebook.com/", { timeout: 120000 });
  });
  await test.step("2. Ensure page has loaded and click button:has-text(\"Create new account\")", async () => {
    await page.waitForLoadState('networkidle', { timeout: 60000 });
    const locator = page.locator("button:has-text(\"Create new account\")");
    await locator.waitFor({ state: 'visible', timeout: 30000 }); // Increased timeout for visibility
    // Confirm the button is enabled before clicking
    await expect(locator).toBeEnabled();
    await locator.click();
  });
});