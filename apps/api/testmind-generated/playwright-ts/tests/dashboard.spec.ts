import { test, expect } from '@playwright/test';

// Page: /dashboard — 1 tests
test("Route /dashboard loads", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/dashboard");
  await expect(page.getByText("Sign")).toBeVisible();
});
