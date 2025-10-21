import { test, expect } from '@playwright/test';

// Auto-generated for page /pricing — 5 test(s)

test("Page loads: /pricing", async ({ page }) => {
  await page.goto("/pricing");
  await expect(page.getByText("JusticePath — Accessible Legal Help")).toBeVisible();
});

test("Navigate /pricing → /", async ({ page }) => {
  await page.goto("/pricing");
  await page.goto("/");
  await expect(page.getByText("Page")).toBeVisible();
});

test("Navigate /pricing → /live-chat", async ({ page }) => {
  await page.goto("/pricing");
  await page.goto("/live-chat");
  await expect(page.getByText("live-chat")).toBeVisible();
});

test("Navigate /pricing → /login", async ({ page }) => {
  await page.goto("/pricing");
  await page.goto("/login");
  await expect(page.getByText("login")).toBeVisible();
});

test("Navigate /pricing → /signup", async ({ page }) => {
  await page.goto("/pricing");
  await page.goto("/signup");
  await expect(page.getByText("signup")).toBeVisible();
});
