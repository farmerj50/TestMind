import { test, expect } from '@playwright/test';
test("Route /#how loads", async ({ page }) => {
  await page.goto("http://localhost:3000");
  await page.goto("http://localhost:3000/#how");
  await expect(page.getByText("Sign")).toBeVisible();
});
