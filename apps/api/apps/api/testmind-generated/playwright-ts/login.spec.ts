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
    await page.waitForTimeout(1000); // Add a short delay before checking visibility
    await expect(locator).toBeVisible({ timeout: 5000 }); // Ensure wait for visibility is consistent
  });
});