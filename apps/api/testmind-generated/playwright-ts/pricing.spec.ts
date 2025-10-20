import { test, expect } from '@playwright/test';

// Auto-generated for page /pricing — 4 test(s)

test("Page loads: /pricing", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/pricing");
  await expect(page.getByText("Sign")).toBeVisible();
});

test("Navigate /pricing → /", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/pricing");
  await page.goto("https://www.justicepathlaw.com/");
  await expect(page.getByText("Page")).toBeVisible();
});

test("Navigate /pricing → /live-chat", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/pricing");
  await page.goto("https://www.justicepathlaw.com/live-chat");
  await expect(page.getByText("live-chat")).toBeVisible();
});

test("Navigate /pricing → /login", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/pricing");
  await page.goto("https://www.justicepathlaw.com/login");
  await expect(page.getByText("login")).toBeVisible();
});
