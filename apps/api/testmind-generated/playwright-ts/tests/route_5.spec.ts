import { test, expect } from '@playwright/test';
test("Route /signin loads", async ({ page }) => {
  await page.goto("http://localhost:3000");
  await page.goto("http://localhost:3000/signin");
  await expect(page.getByText("Sign")).toBeVisible();
});
