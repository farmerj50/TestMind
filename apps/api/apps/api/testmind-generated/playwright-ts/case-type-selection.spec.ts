import { test, expect } from '@playwright/test';

// Auto-generated for page /case-type-selection – 1 test(s)
test("Page loads: /case-type-selection", async ({ page }) => {
  test.info().annotations.push({ type: "parentSuite", description: "Testmind Generated Suite" }, { type: "suite", description: "/case-type-selection" }, { type: "story", description: "Page loads: /case-type-selection" }, { type: "parameter", description: "page=/case-type-selection" });
  await test.step("1. Navigate to /case-type-selection", async () => {
    await page.goto("http://localhost:4173/case-type-selection", { timeout: 60000 });
  });
  await test.step("2. Wait for the page to load completely", async () => {
    await page.waitForLoadState('domcontentloaded');
  });
  await test.step("3. Ensure text \"testmind-web\" is visible", async () => {
    const textElement = page.getByText("testmind-web");
    await expect(textElement).toBeVisible({ timeout: 15000 }); // Increased timeout for visibility check
  });
});