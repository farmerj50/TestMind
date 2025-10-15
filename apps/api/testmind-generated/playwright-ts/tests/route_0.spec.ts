import { test, expect } from '@playwright/test';
test("Route /tm/download loads", async ({ page }) => {
  await page.goto("http://localhost:3000");
  await page.goto("http://localhost:3000/tm/download");
  await expect(page.getByText("Sign")).toBeVisible();
});
