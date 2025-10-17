import { test, expect } from '@playwright/test';

test("404 page for /def-not-found", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/def-not-found");
  await expect(page.getByText("404")).toBeVisible();
});