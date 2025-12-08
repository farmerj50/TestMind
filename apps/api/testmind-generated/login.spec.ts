import { test, expect } from '@playwright/test';

// Auto-generated for page /login – 1 test(s)

test("Page loads: /login", async ({ page }) => {
  test.info().annotations.push({ type: "parentSuite", description: "Testmind Generated Suite" }, { type: "suite", description: "/login" }, { type: "story", description: "Page loads: /login" }, { type: "parameter", description: "page=/login" });
  await test.step("1. Navigate to http://localhost:5173/login", async () => {
    await page.goto("http://localhost:5173/login");
  });
  await test.step("2. Ensure text \"testmind-web\" is visible", async () => {
    await expect(page.getByText("testmind-web")).toBeVisible({ timeout: 10000 });
  });
});
