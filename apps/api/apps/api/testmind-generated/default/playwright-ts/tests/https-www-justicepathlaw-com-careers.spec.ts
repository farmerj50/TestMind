import { test, expect } from '@playwright/test';

test("Route smoke: https://www.justicepathlaw.com/careers", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/careers");
  await expect(page.getByText("Sign")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Links on https://www.justicepathlaw.com/careers: Sign in", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/careers");
  await page.getByText("Sign in").click();
  await expect(page.getByText("Sign")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Links on https://www.justicepathlaw.com/careers: Sign up", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/careers");
  await page.getByText("Sign up").click();
  await expect(page.getByText("Sign")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Links on https://www.justicepathlaw.com/careers: Pricing", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/careers");
  await page.getByText("Pricing").click();
  await expect(page.getByText("Pricing")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Links on https://www.justicepathlaw.com/careers: Contact", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/careers");
  await page.getByText("Contact").click();
  await expect(page.getByText("Contact")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Links on https://www.justicepathlaw.com/careers: Learn", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/careers");
  await page.getByText("Learn").click();
  await expect(page.getByText("Learn")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Links on https://www.justicepathlaw.com/careers: Docs", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/careers");
  await page.getByText("Docs").click();
  await expect(page.getByText("Docs")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Links on https://www.justicepathlaw.com/careers: Dashboard", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/careers");
  await page.getByText("Dashboard").click();
  await expect(page.getByText("Dashboard")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Links on https://www.justicepathlaw.com/careers: Choose plan", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/careers");
  await page.getByText("Choose plan").click();
  await expect(page.getByText("Choose")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Links on https://www.justicepathlaw.com/careers: Start", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/careers");
  await page.getByText("Start").click();
  await expect(page.getByText("Start")).toBeVisible();
});