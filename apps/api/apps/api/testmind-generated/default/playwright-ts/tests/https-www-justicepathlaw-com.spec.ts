import { test, expect } from '@playwright/test';

test("Route smoke: https://www.justicepathlaw.com/", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/");
  await expect(page.getByText("Sign")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Links on https://www.justicepathlaw.com/: Sign in", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/");
  await page.getByText("Sign in").click();
  await expect(page.getByText("Sign")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Links on https://www.justicepathlaw.com/: Sign up", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/");
  await page.getByText("Sign up").click();
  await expect(page.getByText("Sign")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Links on https://www.justicepathlaw.com/: Pricing", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/");
  await page.getByText("Pricing").click();
  await expect(page.getByText("Pricing")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Links on https://www.justicepathlaw.com/: Contact", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/");
  await page.getByText("Contact").click();
  await expect(page.getByText("Contact")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Links on https://www.justicepathlaw.com/: Learn", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/");
  await page.getByText("Learn").click();
  await expect(page.getByText("Learn")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Links on https://www.justicepathlaw.com/: Docs", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/");
  await page.getByText("Docs").click();
  await expect(page.getByText("Docs")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Links on https://www.justicepathlaw.com/: Dashboard", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/");
  await page.getByText("Dashboard").click();
  await expect(page.getByText("Dashboard")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Links on https://www.justicepathlaw.com/: Choose plan", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/");
  await page.getByText("Choose plan").click();
  await expect(page.getByText("Choose")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Links on https://www.justicepathlaw.com/: Start", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/");
  await page.getByText("Start").click();
  await expect(page.getByText("Start")).toBeVisible();
});