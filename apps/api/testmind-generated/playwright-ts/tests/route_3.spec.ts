import { test, expect } from '@playwright/test';
test("Route /#pricing loads", async ({ page }) => {
  await page.goto("http://localhost:3000");
  await page.goto("http://localhost:3000/#pricing");
  await expect(page.getByText("Sign")).toBeVisible();
});
