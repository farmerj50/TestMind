import { test, expect } from '@playwright/test';

// Page: /reset — 1 tests
test("Route /reset loads", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/reset");
  await expect(page.getByText("Sign")).toBeVisible();
});
