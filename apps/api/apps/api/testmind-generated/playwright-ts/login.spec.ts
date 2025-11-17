import { test, expect } from '@playwright/test';

// Auto-generated for page /login – 1 test(s)

test("Page loads: /login", async ({ page }) => {
  test.info().annotations.push({ type: "parentSuite", description: "Testmind Generated Suite" }, { type: "suite", description: "/login" }, { type: "story", description: "Page loads: /login" }, { type: "parameter", description: "page=/login" });
  await test.step("1. Navigate to /login", async () => {
    await page.goto("/login");
  });
  await test.step("2. Ensure text \"TestMind AI\" is visible", async () => {
    await page.waitForSelector("text='TestMind AI'", { timeout: 10000 });
    await expect(page.getByText("TestMind AI")).toBeVisible();
  });
});