import { test, expect } from '@playwright/test';

// Auto-generated for page / – 1 test(s)
test("Decline Marketing Button Functionality", async ({ page }) => {
  test.info().annotations.push({ type: "parentSuite", description: "Testmind Generated Suite" }, { type: "suite", description: "/" }, { type: "story", description: "Decline Marketing Button Functionality" }, { type: "parameter", description: "page=/${page}" });
  
  // Navigating to the base URL defined in the Playwright configuration
  await page.goto("https://bovada.lv/", { timeout: 120000 }); // Increased timeout to 120 seconds
  await page.waitForLoadState('domcontentloaded'); // Wait for DOM to fully load
  await page.waitForLoadState('networkidle'); // Wait for network to be idle
  
  await test.step("1. Click decline marketing button", async () => {
    await page.waitForSelector('button#decline-marketing', { state: 'visible', timeout: 120000 }); // Increased timeout to 120 seconds
    await page.click('button#decline-marketing'); // Valid selector for click action
  });
}, { timeout: 120000 }); // Set default timeout for the test to 120 seconds for stability.