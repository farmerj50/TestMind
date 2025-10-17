import { test, expect } from '@playwright/test';

test("Smoke /site.webmanifest", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/site.webmanifest");
  await expect(page.getByText("Sign in")).toBeVisible();
  await expect(page.getByText("Dashboard")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Flow /site.webmanifest", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/site.webmanifest");
  await page.getByText("Sign in").click();
  await expect(page.getByText("Dashboard")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Route smoke: /site.webmanifest", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/site.webmanifest");
  await expect(page.getByText("Sign")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Links on /site.webmanifest: Sign in", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/site.webmanifest");
  await page.getByText("Sign in").click();
  await expect(page.getByText("Sign")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Links on /site.webmanifest: Sign up", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/site.webmanifest");
  await page.getByText("Sign up").click();
  await expect(page.getByText("Sign")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Links on /site.webmanifest: Pricing", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/site.webmanifest");
  await page.getByText("Pricing").click();
  await expect(page.getByText("Pricing")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Links on /site.webmanifest: Contact", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/site.webmanifest");
  await page.getByText("Contact").click();
  await expect(page.getByText("Contact")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Links on /site.webmanifest: Learn", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/site.webmanifest");
  await page.getByText("Learn").click();
  await expect(page.getByText("Learn")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Links on /site.webmanifest: Docs", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/site.webmanifest");
  await page.getByText("Docs").click();
  await expect(page.getByText("Docs")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Links on /site.webmanifest: Dashboard", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/site.webmanifest");
  await page.getByText("Dashboard").click();
  await expect(page.getByText("Dashboard")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Links on /site.webmanifest: Choose plan", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/site.webmanifest");
  await page.getByText("Choose plan").click();
  await expect(page.getByText("Choose")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Links on /site.webmanifest: Start", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/site.webmanifest");
  await page.getByText("Start").click();
  await expect(page.getByText("Start")).toBeVisible();
});