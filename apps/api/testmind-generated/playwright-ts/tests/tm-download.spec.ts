import { test, expect } from '@playwright/test';

// Page: /tm/download — 1 tests
test("Route /tm/download loads", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/tm/download");
  await expect(page.getByText("Sign")).toBeVisible();
});
