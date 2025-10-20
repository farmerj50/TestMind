import { test, expect } from '@playwright/test';

// Auto-generated for page /signup — 4 test(s)

test("Page loads: /signup", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/signup");
  await expect(page.getByText("Sign")).toBeVisible();
});

test("Navigate /signup → /", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/signup");
  await page.goto("https://www.justicepathlaw.com/");
  await expect(page.getByText("Page")).toBeVisible();
});

test("Navigate /signup → /live-chat", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/signup");
  await page.goto("https://www.justicepathlaw.com/live-chat");
  await expect(page.getByText("live-chat")).toBeVisible();
});

test("Navigate /signup → /pricing", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/signup");
  await page.goto("https://www.justicepathlaw.com/pricing");
  await expect(page.getByText("pricing")).toBeVisible();
});
