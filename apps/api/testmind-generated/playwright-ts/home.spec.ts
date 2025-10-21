import { test, expect } from '@playwright/test';

// Auto-generated for page / — 7 test(s)

test("Page loads: /", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("JusticePath — Accessible Legal Help")).toBeVisible();
});

test("Navigate / → /live-chat", async ({ page }) => {
  await page.goto("/");
  await page.goto("/live-chat");
  await expect(page.getByText("live-chat")).toBeVisible();
});

test("Navigate / → /pricing", async ({ page }) => {
  await page.goto("/");
  await page.goto("/pricing");
  await expect(page.getByText("pricing")).toBeVisible();
});

test("Navigate / → /login", async ({ page }) => {
  await page.goto("/");
  await page.goto("/login");
  await expect(page.getByText("login")).toBeVisible();
});

test("Navigate / → /signup", async ({ page }) => {
  await page.goto("/");
  await page.goto("/signup");
  await expect(page.getByText("signup")).toBeVisible();
});

test("Navigate / → /select-plan", async ({ page }) => {
  await page.goto("/");
  await page.goto("/select-plan");
  await expect(page.getByText("select-plan")).toBeVisible();
});

test("Navigate / → /case-type-selection", async ({ page }) => {
  await page.goto("/");
  await page.goto("/case-type-selection");
  await expect(page.getByText("case-type-selection")).toBeVisible();
});
