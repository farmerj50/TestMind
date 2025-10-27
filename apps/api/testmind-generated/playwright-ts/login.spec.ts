import { test, expect } from '@playwright/test';

// Auto-generated for page /login — 1 test(s)

test("Page loads: /login", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByText("testmind-web")).toBeVisible();
});
