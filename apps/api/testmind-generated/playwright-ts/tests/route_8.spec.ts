import { test, expect } from '@playwright/test';
test("Route /signup?plan=pro loads", async ({ page }) => {
  await page.goto("http://localhost:3000");
  await page.goto("http://localhost:3000/signup?plan=pro");
  await expect(page.getByText("Sign")).toBeVisible();
});
