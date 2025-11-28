import { test, expect } from '@playwright/test';

// Auto-generated for page /case-type-selection – 1 test(s)
test("Page loads: /case-type-selection", async ({ page }) => {
  test.info().annotations.push({ type: "parentSuite", description: "Testmind Generated Suite" }, { type: "suite", description: "/case-type-selection" }, { type: "story", description: "Page loads: /case-type-selection" }, { type: "parameter", description: "page=/case-type-selection" });
  await test.step("1. Navigate to /case-type-selection", async () => {
    await page.goto("/case-type-selection");
  });
  await test.step("2. Ensure the page has loaded before checking visibility", async () => {
    await page.waitForLoadState('domcontentloaded');  // Changed to domcontentloaded for more reliable page readiness
  });
  await test.step("3. Ensure text \"testmind-web\" is visible", async () => {
    const textElement = page.getByText("testmind-web");
    await textElement.waitFor({ state: 'visible', timeout: 10000 }); // Wait for the element to be visible before assertion
    await expect(textElement).toBeVisible({ timeout: 10000 }); // Added timeout for visibility check
  });
});