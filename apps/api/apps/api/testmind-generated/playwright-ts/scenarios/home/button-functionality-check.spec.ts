import { test, expect } from '@playwright/test';

// Auto-generated for page / – 1 test(s)

test("Button Functionality Check", async ({ page }) => {
  test.info().annotations.push({ type: "parentSuite", description: "Testmind Generated Suite" }, { type: "suite", description: "/" }, { type: "story", description: "Button Functionality Check" }, { type: "parameter", description: "page=/" });
  await test.step("1. Navigate to http://localhost:5173/", async () => {
    await page.goto("http://localhost:5173/");
  });
  await test.step("2. Click the first button that says 'Do you commit tests to our'", async () => {
    const locator = page.locator("button:has-text('Do you commit tests to our')").nth(0);
    await locator.waitFor({ state: 'visible', timeout: 15000 });
    await locator.click({ timeout: 15000 });
  });
  await test.step("3. Click the second button that says 'Will you store our secrets?'", async () => {
    const locator = page.locator("button:has-text('Will you store our secrets?')").nth(0);
    await locator.waitFor({ state: 'visible', timeout: 15000 });
    await locator.click({ timeout: 15000 });
  });
});