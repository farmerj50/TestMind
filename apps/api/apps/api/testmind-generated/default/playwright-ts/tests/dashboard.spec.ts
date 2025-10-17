import { test, expect } from '@playwright/test';

test("Auth gate for /dashboard", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/dashboard");
  await expect(page.getByText("Sign in")).toBeVisible();
});