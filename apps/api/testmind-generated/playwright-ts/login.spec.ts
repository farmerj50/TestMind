import { test, expect } from '@playwright/test';

// Auto-generated for page /login — 6 test(s)

test("Page loads: /login", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByText("JusticePath — Accessible Legal Help")).toBeVisible();
});

test("Form submits – /login", async ({ page }) => {
  await page.goto("/login");
  await page.locator("[name='Email Address'], #Email Address").fill("qa+auto@example.com");
  await page.locator("[name='Password'], #Password").fill("P@ssw0rd1!");
  await page.locator("[name='Email Address'], #Email Address").fill("qa+auto@example.com");
  await page.locator("[name='Password'], #Password").fill("P@ssw0rd1!");
  await page.locator("button[type='submit'], input[type='submit']").click();
  await expect(page.getByText("success")).toBeVisible();
});

test("Navigate /login → /", async ({ page }) => {
  await page.goto("/login");
  await page.goto("/");
  await expect(page.getByText("Page")).toBeVisible();
});

test("Navigate /login → /live-chat", async ({ page }) => {
  await page.goto("/login");
  await page.goto("/live-chat");
  await expect(page.getByText("live-chat")).toBeVisible();
});

test("Navigate /login → /pricing", async ({ page }) => {
  await page.goto("/login");
  await page.goto("/pricing");
  await expect(page.getByText("pricing")).toBeVisible();
});

test("Navigate /login → /signup", async ({ page }) => {
  await page.goto("/login");
  await page.goto("/signup");
  await expect(page.getByText("signup")).toBeVisible();
});
