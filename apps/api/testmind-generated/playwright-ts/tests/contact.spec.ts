import { test, expect } from '@playwright/test';

// Page: /contact — 1 tests
test("Route /contact loads", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/contact");
  await expect(page.getByText("Sign")).toBeVisible();
});
