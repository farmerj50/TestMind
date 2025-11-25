import { test, expect } from '@playwright/test';

// Auto-generated for page /login – 1 test(s)

test("Page loads: https:localhost:5173", async ({ page }) => {
  test.info().annotations.push({ type: "parentSuite", description: "Testmind Generated Suite" }, { type: "suite", description: "/login" }, { type: "story", description: "Page loads: /login" }, { type: "parameter", description: "page=/login" });
  await test.step("1. Navigate to https:localhost:5173", async () => {
    await page.goto("https:localhost:5173");
  });
  await test.step("2. Ensure text \"testmind-web\" is visible", async () => {
    await expect(page.getByText("testmind-web")).toBeVisible();
  });
});
