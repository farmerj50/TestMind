import { test, expect } from '@playwright/test';
test("Route /projects/:id loads", async ({ page }) => {
  await page.goto("http://localhost:3000");
  await page.goto("http://localhost:3000/projects/:id");
  await expect(page.getByText("Sign")).toBeVisible();
});
