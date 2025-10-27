import { test, expect } from '@playwright/test';

// Auto-generated for page /contact — 6 test(s)

test("Page loads: /contact", async ({ page }) => {
  await page.goto("/contact");
  await expect(page.getByText("testmind-web")).toBeVisible();
});

test("Navigate /contact → /", async ({ page }) => {
  await page.goto("/contact");
  await page.goto("/");
  await expect(page.getByText("Page")).toBeVisible();
});

test("Navigate /contact → /pricing", async ({ page }) => {
  await page.goto("/contact");
  await page.goto("/pricing");
  await expect(page.getByText("pricing")).toBeVisible();
});

test("Navigate /contact → /signin", async ({ page }) => {
  await page.goto("/contact");
  await page.goto("/signin");
  await expect(page.getByText("signin")).toBeVisible();
});

test("Navigate /contact → /signup", async ({ page }) => {
  await page.goto("/contact");
  await page.goto("/signup");
  await expect(page.getByText("signup")).toBeVisible();
});

test("Navigate /contact → /dashboard", async ({ page }) => {
  await page.goto("/contact");
  await page.goto("/dashboard");
  await expect(page.getByText("dashboard")).toBeVisible();
});
