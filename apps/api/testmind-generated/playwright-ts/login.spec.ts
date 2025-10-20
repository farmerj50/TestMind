import { test, expect } from '@playwright/test';

// Auto-generated for page /login — 4 test(s)

test("Page loads: /login", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/login");
  await expect(page.getByText("Sign")).toBeVisible();
});

test("Navigate /login → /", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/login");
  await page.goto("https://www.justicepathlaw.com/");
  await expect(page.getByText("Page")).toBeVisible();
});

test("Navigate /login → /live-chat", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/login");
  await page.goto("https://www.justicepathlaw.com/live-chat");
  await expect(page.getByText("live-chat")).toBeVisible();
});

test("Navigate /login → /pricing", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/login");
  await page.goto("https://www.justicepathlaw.com/pricing");
  await expect(page.getByText("pricing")).toBeVisible();
});
