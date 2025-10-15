import { test, expect } from '@playwright/test';
test("Route /signup loads", async ({ page }) => {
  await page.goto("http://localhost:3000");
  await page.goto("http://localhost:3000/signup");
  await expect(page.getByText("Sign")).toBeVisible();
});
