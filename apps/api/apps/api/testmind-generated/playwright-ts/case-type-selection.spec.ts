import { test, expect } from '@playwright/test';

// Auto-generated for page /case-type-selection – 1 test(s)

test("Page loads: /case-type-selection", async ({ page }) => {
  test.info().annotations.push({ type: "parentSuite", description: "Testmind Generated Suite" }, { type: "suite", description: "/case-type-selection" }, { type: "story", description: "Page loads: /case-type-selection" }, { type: "parameter", description: "page=/case-type-selection" });
  await test.step("1. Navigate to /case-type-selection", async () => {
    await page.goto("/case-type-selection");
  });
  await test.step("2. Ensure the page has loaded before checking visibility", async () => {
    await page.waitForLoadState('load');  
  });
  await test.step("3. Ensure text \"TestMind AI\" is visible", async () => {
    const textElement = page.getByText("TestMind AI");
    await textElement.waitFor({ state: 'attached' }); // Wait for the text element to be attached to the DOM
    await expect(textElement).toBeVisible(); // Assert visibility after ensuring it is attached
  });
});