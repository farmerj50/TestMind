import { test, expect } from '@playwright/test';

test("Route smoke: https://www.justicepathlaw.com/privacy", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/privacy");
  await expect(page.getByText("Sign")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Links on https://www.justicepathlaw.com/privacy: Sign in", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/privacy");
  await page.getByText("Sign in").click();
  await expect(page.getByText("Sign")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Links on https://www.justicepathlaw.com/privacy: Sign up", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/privacy");
  await page.getByText("Sign up").click();
  await expect(page.getByText("Sign")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Links on https://www.justicepathlaw.com/privacy: Pricing", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/privacy");
  await page.getByText("Pricing").click();
  await expect(page.getByText("Pricing")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Links on https://www.justicepathlaw.com/privacy: Contact", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/privacy");
  await page.getByText("Contact").click();
  await expect(page.getByText("Contact")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Links on https://www.justicepathlaw.com/privacy: Learn", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/privacy");
  await page.getByText("Learn").click();
  await expect(page.getByText("Learn")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Links on https://www.justicepathlaw.com/privacy: Docs", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/privacy");
  await page.getByText("Docs").click();
  await expect(page.getByText("Docs")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Links on https://www.justicepathlaw.com/privacy: Dashboard", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/privacy");
  await page.getByText("Dashboard").click();
  await expect(page.getByText("Dashboard")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Links on https://www.justicepathlaw.com/privacy: Choose plan", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/privacy");
  await page.getByText("Choose plan").click();
  await expect(page.getByText("Choose")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Links on https://www.justicepathlaw.com/privacy: Start", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/privacy");
  await page.getByText("Start").click();
  await expect(page.getByText("Start")).toBeVisible();
});