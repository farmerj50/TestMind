import { test, expect } from '@playwright/test';

// Auto-generated for page / – 1 test(s)
test("Decline Marketing Button Functionality", async ({ page }) => {
  test.info().annotations.push({ type: "parentSuite", description: "Testmind Generated Suite" }, { type: "suite", description: "/" }, { type: "story", description: "Decline Marketing Button Functionality" }, { type: "parameter", description: "page=/${page}" });
  // Navigating to the base URL defined in the Playwright configuration
  await page.goto("http://localhost:3000/", { waitUntil: 'networkidle' }); // Updated port to 3000
  await test.step("1. Click decline marketing button", async () => {
    await page.click('button#decline-marketing'); // Added a valid selector for click action
  });
}, { timeout: 60000 }); // Set timeout to 60 seconds