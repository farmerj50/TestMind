import { test, expect } from '@playwright/test';

// Page: /signin — 1 tests
test("Route /signin loads", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/signin");
  await expect(page.getByText("Sign")).toBeVisible();
});
