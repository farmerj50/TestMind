import { test, expect } from '@playwright/test';

test("Smoke /icons/icon-192.png", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/icons/icon-192.png");
  await expect(page.getByText("Sign in")).toBeVisible();
  await expect(page.getByText("Dashboard")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Flow /icons/icon-192.png", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/icons/icon-192.png");
  await page.getByText("Sign in").click();
  await expect(page.getByText("Dashboard")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Route smoke: /icons/icon-192.png", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/icons/icon-192.png");
  await expect(page.getByText("Sign")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Links on /icons/icon-192.png: Sign in", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/icons/icon-192.png");
  await page.getByText("Sign in").click();
  await expect(page.getByText("Sign")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Links on /icons/icon-192.png: Sign up", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/icons/icon-192.png");
  await page.getByText("Sign up").click();
  await expect(page.getByText("Sign")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Links on /icons/icon-192.png: Pricing", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/icons/icon-192.png");
  await page.getByText("Pricing").click();
  await expect(page.getByText("Pricing")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Links on /icons/icon-192.png: Contact", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/icons/icon-192.png");
  await page.getByText("Contact").click();
  await expect(page.getByText("Contact")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Links on /icons/icon-192.png: Learn", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/icons/icon-192.png");
  await page.getByText("Learn").click();
  await expect(page.getByText("Learn")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Links on /icons/icon-192.png: Docs", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/icons/icon-192.png");
  await page.getByText("Docs").click();
  await expect(page.getByText("Docs")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Links on /icons/icon-192.png: Dashboard", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/icons/icon-192.png");
  await page.getByText("Dashboard").click();
  await expect(page.getByText("Dashboard")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Links on /icons/icon-192.png: Choose plan", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/icons/icon-192.png");
  await page.getByText("Choose plan").click();
  await expect(page.getByText("Choose")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Links on /icons/icon-192.png: Start", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/icons/icon-192.png");
  await page.getByText("Start").click();
  await expect(page.getByText("Start")).toBeVisible();
});