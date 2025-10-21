import { test, expect } from '@playwright/test';

// Auto-generated for page /select-plan — 6 test(s)

test("Page loads: /select-plan", async ({ page }) => {
  await page.goto("/select-plan");
  await expect(page.getByText("JusticePath — Accessible Legal Help")).toBeVisible();
});

test("Navigate /select-plan → /", async ({ page }) => {
  await page.goto("/select-plan");
  await page.goto("/");
  await expect(page.getByText("Page")).toBeVisible();
});

test("Navigate /select-plan → /live-chat", async ({ page }) => {
  await page.goto("/select-plan");
  await page.goto("/live-chat");
  await expect(page.getByText("live-chat")).toBeVisible();
});

test("Navigate /select-plan → /pricing", async ({ page }) => {
  await page.goto("/select-plan");
  await page.goto("/pricing");
  await expect(page.getByText("pricing")).toBeVisible();
});

test("Navigate /select-plan → /login", async ({ page }) => {
  await page.goto("/select-plan");
  await page.goto("/login");
  await expect(page.getByText("login")).toBeVisible();
});

test("Navigate /select-plan → /signup", async ({ page }) => {
  await page.goto("/select-plan");
  await page.goto("/signup");
  await expect(page.getByText("signup")).toBeVisible();
});
