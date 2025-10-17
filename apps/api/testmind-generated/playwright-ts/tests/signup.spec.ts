import { test, expect } from '@playwright/test';

// Page: /signup — 4 tests
test("Route /signup loads", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/signup");
  await expect(page.getByText("Sign")).toBeVisible();
});

test("Route /signup?plan=free loads", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/signup?plan=free");
  await expect(page.getByText("Sign")).toBeVisible();
});

test("Route /signup?plan=pro loads", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/signup?plan=pro");
  await expect(page.getByText("Sign")).toBeVisible();
});

test("Route /signup?plan=team loads", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/signup?plan=team");
  await expect(page.getByText("Sign")).toBeVisible();
});
