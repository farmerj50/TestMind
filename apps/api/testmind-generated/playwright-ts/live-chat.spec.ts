import { test, expect } from '@playwright/test';

// Auto-generated for page /live-chat — 6 test(s)

test("Page loads: /live-chat", async ({ page }) => {
  await page.goto("/live-chat");
  await expect(page.getByText("JusticePath — Accessible Legal Help")).toBeVisible();
});

test("Form submits – /live-chat", async ({ page }) => {
  await page.goto("/live-chat");
  await page.locator("[name='Jurisdiction (e.g., Atlanta, GA)'], #Jurisdiction (e.g., Atlanta, GA)").fill("Test value");
  await page.locator("button[type='submit'], input[type='submit']").click();
  await expect(page.getByText("success")).toBeVisible();
});

test("Navigate /live-chat → /", async ({ page }) => {
  await page.goto("/live-chat");
  await page.goto("/");
  await expect(page.getByText("Page")).toBeVisible();
});

test("Navigate /live-chat → /pricing", async ({ page }) => {
  await page.goto("/live-chat");
  await page.goto("/pricing");
  await expect(page.getByText("pricing")).toBeVisible();
});

test("Navigate /live-chat → /login", async ({ page }) => {
  await page.goto("/live-chat");
  await page.goto("/login");
  await expect(page.getByText("login")).toBeVisible();
});

test("Navigate /live-chat → /signup", async ({ page }) => {
  await page.goto("/live-chat");
  await page.goto("/signup");
  await expect(page.getByText("signup")).toBeVisible();
});
