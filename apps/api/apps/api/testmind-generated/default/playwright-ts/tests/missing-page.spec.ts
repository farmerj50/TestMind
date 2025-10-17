import { test, expect } from '@playwright/test';

test("404 page for /missing/page", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/missing/page");
  await expect(page.getByText("404")).toBeVisible();
});