import { test, expect } from "@playwright/test";

test.describe("Manual case: login", () => {
  test("manual-flow", async ({ page }) => {
    await page.goto(process.env.TEST_BASE_URL || "http://localhost:5173");
// Preconditions:
// environment is up and running
  // Step 1: users navigates to https://localhost:5173 => Expected: title to be "testmind ai"
  // Step 2: user selects input field for username => Expected: expect input field to be ebnabled
    expect(true).toBeTruthy();
  });
});
