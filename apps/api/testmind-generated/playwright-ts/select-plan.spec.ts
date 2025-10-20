import { test, expect } from '@playwright/test';

// Auto-generated for page /select-plan — 4 test(s)

test("Page loads: /select-plan", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/select-plan");
  await expect(page.getByText("Sign")).toBeVisible();
});

test("Navigate /select-plan → /", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/select-plan");
  await page.goto("https://www.justicepathlaw.com/");
  await expect(page.getByText("Page")).toBeVisible();
});

test("Navigate /select-plan → /live-chat", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/select-plan");
  await page.goto("https://www.justicepathlaw.com/live-chat");
  await expect(page.getByText("live-chat")).toBeVisible();
});

test("Navigate /select-plan → /pricing", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/select-plan");
  await page.goto("https://www.justicepathlaw.com/pricing");
  await expect(page.getByText("pricing")).toBeVisible();
});
