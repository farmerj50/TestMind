import { test, expect } from '@playwright/test';

// Page: /foo — 1 tests
test("Route /foo loads", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/foo");
  await expect(page.getByText("Sign")).toBeVisible();
});
