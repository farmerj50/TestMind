import { test, expect } from "@playwright/test";

test.describe("Manual case: login", () => {
  test("manual-flow", async ({ page }) => {
    await page.goto(process.env.TEST_BASE_URL || "http://localhost:5173");
  // No steps provided.
    expect(true).toBeTruthy();
  });
});
