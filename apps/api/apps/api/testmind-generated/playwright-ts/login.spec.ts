import { test, expect } from '@playwright/test';

// Auto-generated for page /login – 1 test(s)

test("Page loads: /login", async ({ page }) => {
  test.info().annotations.push({ type: "parentSuite", description: "Testmind Generated Suite" }, { type: "suite", description: "/login" }, { type: "story", description: "Page loads: /login" }, { type: "parameter", description: "page=/login" });
  await test.step("1. Navigate to /login", async () => {
    await page.goto("/login");
    await page.waitForLoadState('networkidle'); // Ensure page is fully loaded
  });
  await test.step("2. Ensure text \"testmind-web\" is visible", async () => {
    const locator = page.locator("text=testmind-web"); // Ensured proper targeting
    await locator.waitFor({ state: 'visible', timeout: 10000 }); // Wait for the text to be visible
    await expect(locator).toBeVisible(); // Assertion for visibility
  });
});