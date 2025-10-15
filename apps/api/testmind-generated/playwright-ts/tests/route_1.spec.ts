import { test, expect } from '@playwright/test';
test("Route /#features loads", async ({ page }) => {
  await page.goto("http://localhost:3000");
  await page.goto("http://localhost:3000/#features");
  await expect(page.getByText("Sign")).toBeVisible();
});
