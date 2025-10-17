import { test, expect } from '@playwright/test';

// Page: / — 6 tests
test("Smoke – home loads", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com");
  await expect(page.getByText("Sign in")).toBeVisible();
  await expect(page.getByText("Dashboard")).toBeVisible();
});

test("Primary CTAs", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com");
  await page.getByText("Get started").click();
  await page.getByText("Sign in").click();
  await page.getByText("Sign up").click();
});

test("Route /#features loads", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/#features");
  await expect(page.getByText("Sign")).toBeVisible();
});

test("Route /#how loads", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/#how");
  await expect(page.getByText("Sign")).toBeVisible();
});

test("Route /#pricing loads", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/#pricing");
  await expect(page.getByText("Sign")).toBeVisible();
});

test("Route /#faq loads", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/#faq");
  await expect(page.getByText("Sign")).toBeVisible();
});
