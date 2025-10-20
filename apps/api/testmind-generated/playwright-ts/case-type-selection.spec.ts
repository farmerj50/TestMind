import { test, expect } from '@playwright/test';

// Auto-generated for page /case-type-selection — 4 test(s)

test("Page loads: /case-type-selection", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/case-type-selection");
  await expect(page.getByText("Sign")).toBeVisible();
});

test("Navigate /case-type-selection → /", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/case-type-selection");
  await page.goto("https://www.justicepathlaw.com/");
  await expect(page.getByText("Page")).toBeVisible();
});

test("Navigate /case-type-selection → /live-chat", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/case-type-selection");
  await page.goto("https://www.justicepathlaw.com/live-chat");
  await expect(page.getByText("live-chat")).toBeVisible();
});

test("Navigate /case-type-selection → /pricing", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/case-type-selection");
  await page.goto("https://www.justicepathlaw.com/pricing");
  await expect(page.getByText("pricing")).toBeVisible();
});
