import { test, expect } from '@playwright/test';

test("Route smoke: https://www.justicepathlaw.com/news", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/news");
  await expect(page.getByText("Sign")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Links on https://www.justicepathlaw.com/news: Sign in", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/news");
  await page.getByText("Sign in").click();
  await expect(page.getByText("Sign")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Links on https://www.justicepathlaw.com/news: Sign up", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/news");
  await page.getByText("Sign up").click();
  await expect(page.getByText("Sign")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Links on https://www.justicepathlaw.com/news: Pricing", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/news");
  await page.getByText("Pricing").click();
  await expect(page.getByText("Pricing")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Links on https://www.justicepathlaw.com/news: Contact", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/news");
  await page.getByText("Contact").click();
  await expect(page.getByText("Contact")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Links on https://www.justicepathlaw.com/news: Learn", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/news");
  await page.getByText("Learn").click();
  await expect(page.getByText("Learn")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Links on https://www.justicepathlaw.com/news: Docs", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/news");
  await page.getByText("Docs").click();
  await expect(page.getByText("Docs")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Links on https://www.justicepathlaw.com/news: Dashboard", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/news");
  await page.getByText("Dashboard").click();
  await expect(page.getByText("Dashboard")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Links on https://www.justicepathlaw.com/news: Choose plan", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/news");
  await page.getByText("Choose plan").click();
  await expect(page.getByText("Choose")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Links on https://www.justicepathlaw.com/news: Start", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/news");
  await page.getByText("Start").click();
  await expect(page.getByText("Start")).toBeVisible();
});