import { test, expect } from '@playwright/test';

// Auto-generated for page /case-type-selection — 6 test(s)

test("Page loads: /case-type-selection", async ({ page }) => {
  await page.goto("/case-type-selection");
  await expect(page.getByText("JusticePath — Accessible Legal Help")).toBeVisible();
});

test("Navigate /case-type-selection → /", async ({ page }) => {
  await page.goto("/case-type-selection");
  await page.goto("/");
  await expect(page.getByText("Page")).toBeVisible();
});

test("Navigate /case-type-selection → /live-chat", async ({ page }) => {
  await page.goto("/case-type-selection");
  await page.goto("/live-chat");
  await expect(page.getByText("live-chat")).toBeVisible();
});

test("Navigate /case-type-selection → /pricing", async ({ page }) => {
  await page.goto("/case-type-selection");
  await page.goto("/pricing");
  await expect(page.getByText("pricing")).toBeVisible();
});

test("Navigate /case-type-selection → /login", async ({ page }) => {
  await page.goto("/case-type-selection");
  await page.goto("/login");
  await expect(page.getByText("login")).toBeVisible();
});

test("Navigate /case-type-selection → /signup", async ({ page }) => {
  await page.goto("/case-type-selection");
  await page.goto("/signup");
  await expect(page.getByText("signup")).toBeVisible();
});
