import { test, expect } from '@playwright/test';

// Auto-generated for page /projects – 1 test(s)

test("Page loads: /projects", async ({ page }) => {
  test.info().annotations.push({ type: "parentSuite", description: "Testmind Generated Suite" }, { type: "suite", description: "/projects" }, { type: "story", description: "Page loads: /projects" }, { type: "parameter", description: "page=/projects" });
  await test.step("1. Navigate to http://localhost:5173/projects", async () => {
    await page.goto("http://localhost:5173/projects");
  });
  await test.step("2. Ensure text \"Sign\" is visible", async () => {
    await expect(page.getByText("Sign")).toBeVisible({ timeout: 10000 });
  });
});
