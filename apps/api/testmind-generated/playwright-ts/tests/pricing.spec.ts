import { test, expect } from '@playwright/test';

// Page: /pricing — 1 tests
test("Route /pricing loads", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/pricing");
  await expect(page.getByText("Sign")).toBeVisible();
});
