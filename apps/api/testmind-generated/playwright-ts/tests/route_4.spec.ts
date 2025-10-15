import { test, expect } from '@playwright/test';
test("Route /#faq loads", async ({ page }) => {
  await page.goto("http://localhost:3000");
  await page.goto("http://localhost:3000/#faq");
  await expect(page.getByText("Sign")).toBeVisible();
});
