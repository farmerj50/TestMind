import { test, expect } from '@playwright/test';

test("Route smoke: https://www.justicepathlaw.com/terms", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/terms");
  await expect(page.getByText("Sign")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Links on https://www.justicepathlaw.com/terms: Sign in", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/terms");
  await page.getByText("Sign in").click();
  await expect(page.getByText("Sign")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Links on https://www.justicepathlaw.com/terms: Sign up", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/terms");
  await page.getByText("Sign up").click();
  await expect(page.getByText("Sign")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Links on https://www.justicepathlaw.com/terms: Pricing", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/terms");
  await page.getByText("Pricing").click();
  await expect(page.getByText("Pricing")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Links on https://www.justicepathlaw.com/terms: Contact", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/terms");
  await page.getByText("Contact").click();
  await expect(page.getByText("Contact")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Links on https://www.justicepathlaw.com/terms: Learn", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/terms");
  await page.getByText("Learn").click();
  await expect(page.getByText("Learn")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Links on https://www.justicepathlaw.com/terms: Docs", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/terms");
  await page.getByText("Docs").click();
  await expect(page.getByText("Docs")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Links on https://www.justicepathlaw.com/terms: Dashboard", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/terms");
  await page.getByText("Dashboard").click();
  await expect(page.getByText("Dashboard")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Links on https://www.justicepathlaw.com/terms: Choose plan", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/terms");
  await page.getByText("Choose plan").click();
  await expect(page.getByText("Choose")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Links on https://www.justicepathlaw.com/terms: Start", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/terms");
  await page.getByText("Start").click();
  await expect(page.getByText("Start")).toBeVisible();
});