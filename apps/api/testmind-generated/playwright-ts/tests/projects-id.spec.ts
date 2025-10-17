import { test, expect } from '@playwright/test';

// Page: /projects/:id — 1 tests
test("Route /projects/:id loads", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/projects/:id");
  await expect(page.getByText("Sign")).toBeVisible();
});
