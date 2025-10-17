import { test, expect } from '@playwright/test';

test("404 page for /zzz/404", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/zzz/404");
  await expect(page.getByText("404")).toBeVisible();
});