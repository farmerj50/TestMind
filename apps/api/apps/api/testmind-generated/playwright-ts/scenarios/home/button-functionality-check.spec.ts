import { test, expect } from '@playwright/test';

// Auto-generated for page / – 1 test(s)

test("Button Functionality Check", async ({ page }) => {
  test.info().annotations.push({ type: "parentSuite", description: "Testmind Generated Suite" }, { type: "suite", description: "/" }, { type: "story", description: "Button Functionality Check" }, { type: "parameter", description: "page=/{" });
  await test.step("1. Navigate to http://localhost:5173/", async () => {
    await page.goto("http://localhost:5173/", { waitUntil: 'networkidle', timeout: 60000 });
  });
  await test.step("2. Click the first button that says 'Start'", async () => {
    const locator = page.getByRole('button', { name: /^(start|get started|run|submit|begin).first().first().first().first().first().first().first()$/i });
    await expect(locator).toBeVisible({ timeout: 15000 });
    await locator.click();
  });
  await test.step("3. Click the second button that says 'Store secrets'", async () => {
    const locator = page.getByRole('button', { name: /store secrets/i });
    await expect(locator).toBeVisible({ timeout: 15000 });
    await locator.click();
  });
});