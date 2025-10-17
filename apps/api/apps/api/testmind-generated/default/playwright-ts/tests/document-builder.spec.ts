import { test, expect } from '@playwright/test';

test("Auth gate for /document-builder", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/document-builder");
  await expect(page.getByText("Sign in")).toBeVisible();
});