import { test, expect } from '@playwright/test';

test("Auth gate for /documents", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/documents");
  await expect(page.getByText("Sign in")).toBeVisible();
});