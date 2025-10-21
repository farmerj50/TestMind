import { test, expect } from '@playwright/test';

// Auto-generated for page /signup — 6 test(s)

test("Page loads: /signup", async ({ page }) => {
  await page.goto("/signup");
  await expect(page.getByText("JusticePath — Accessible Legal Help")).toBeVisible();
});

test("Form submits – /signup", async ({ page }) => {
  await page.goto("/signup");
  await page.locator("[name='Full Name'], #Full Name").fill("QA Auto");
  await page.locator("[name='Email Address'], #Email Address").fill("qa+auto@example.com");
  await page.locator("[name='Password'], #Password").fill("P@ssw0rd1!");
  await page.locator("[name='Confirm Password'], #Confirm Password").fill("P@ssw0rd1!");
  await page.locator("[name='Full Name'], #Full Name").fill("QA Auto");
  await page.locator("[name='Email Address'], #Email Address").fill("qa+auto@example.com");
  await page.locator("[name='Password'], #Password").fill("P@ssw0rd1!");
  await page.locator("[name='Confirm Password'], #Confirm Password").fill("P@ssw0rd1!");
  await page.locator("button[type='submit'], input[type='submit']").click();
  await expect(page.getByText("success")).toBeVisible();
});

test("Navigate /signup → /", async ({ page }) => {
  await page.goto("/signup");
  await page.goto("/");
  await expect(page.getByText("Page")).toBeVisible();
});

test("Navigate /signup → /live-chat", async ({ page }) => {
  await page.goto("/signup");
  await page.goto("/live-chat");
  await expect(page.getByText("live-chat")).toBeVisible();
});

test("Navigate /signup → /pricing", async ({ page }) => {
  await page.goto("/signup");
  await page.goto("/pricing");
  await expect(page.getByText("pricing")).toBeVisible();
});

test("Navigate /signup → /login", async ({ page }) => {
  await page.goto("/signup");
  await page.goto("/login");
  await expect(page.getByText("login")).toBeVisible();
});
