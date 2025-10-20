import { test, expect } from '@playwright/test';

// Auto-generated for page /live-chat — 4 test(s)

test("Page loads: /live-chat", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/live-chat");
  await expect(page.getByText("Sign")).toBeVisible();
});

test("Navigate /live-chat → /", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/live-chat");
  await page.goto("https://www.justicepathlaw.com/");
  await expect(page.getByText("Page")).toBeVisible();
});

test("Navigate /live-chat → /pricing", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/live-chat");
  await page.goto("https://www.justicepathlaw.com/pricing");
  await expect(page.getByText("pricing")).toBeVisible();
});

test("Navigate /live-chat → /login", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/live-chat");
  await page.goto("https://www.justicepathlaw.com/login");
  await expect(page.getByText("login")).toBeVisible();
});
