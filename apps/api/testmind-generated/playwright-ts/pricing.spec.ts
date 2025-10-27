import { test, expect } from '@playwright/test';

// Auto-generated for page /pricing — 6 test(s)

test("Page loads: /pricing", async ({ page }) => {
  await page.goto("/pricing");
  await expect(page.getByText("testmind-web")).toBeVisible();
});

test("Navigate /pricing → /", async ({ page }) => {
  await page.goto("/pricing");
  await page.goto("/");
  await expect(page.getByText("Page")).toBeVisible();
});

test("Navigate /pricing → /contact", async ({ page }) => {
  await page.goto("/pricing");
  await page.goto("/contact");
  await expect(page.getByText("contact")).toBeVisible();
});

test("Navigate /pricing → /signin", async ({ page }) => {
  await page.goto("/pricing");
  await page.goto("/signin");
  await expect(page.getByText("signin")).toBeVisible();
});

test("Navigate /pricing → /signup", async ({ page }) => {
  await page.goto("/pricing");
  await page.goto("/signup");
  await expect(page.getByText("signup")).toBeVisible();
});

test("Navigate /pricing → /dashboard", async ({ page }) => {
  await page.goto("/pricing");
  await page.goto("/dashboard");
  await expect(page.getByText("dashboard")).toBeVisible();
});
