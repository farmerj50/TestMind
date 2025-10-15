import { test, expect } from '@playwright/test';
test("Route /dashboard loads", async ({ page }) => {
  await page.goto("http://localhost:3000");
  await page.goto("http://localhost:3000/dashboard");
  await expect(page.getByText("Sign")).toBeVisible();
});
