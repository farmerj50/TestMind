import { test, expect } from '@playwright/test';

test("Route smoke: https://www.justicepathlaw.com/services", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/services");
  await expect(page.getByText("Sign")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Links on https://www.justicepathlaw.com/services: Sign in", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/services");
  await page.getByText("Sign in").click();
  await expect(page.getByText("Sign")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Links on https://www.justicepathlaw.com/services: Sign up", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/services");
  await page.getByText("Sign up").click();
  await expect(page.getByText("Sign")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Links on https://www.justicepathlaw.com/services: Pricing", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/services");
  await page.getByText("Pricing").click();
  await expect(page.getByText("Pricing")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Links on https://www.justicepathlaw.com/services: Contact", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/services");
  await page.getByText("Contact").click();
  await expect(page.getByText("Contact")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Links on https://www.justicepathlaw.com/services: Learn", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/services");
  await page.getByText("Learn").click();
  await expect(page.getByText("Learn")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Links on https://www.justicepathlaw.com/services: Docs", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/services");
  await page.getByText("Docs").click();
  await expect(page.getByText("Docs")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Links on https://www.justicepathlaw.com/services: Dashboard", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/services");
  await page.getByText("Dashboard").click();
  await expect(page.getByText("Dashboard")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Links on https://www.justicepathlaw.com/services: Choose plan", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/services");
  await page.getByText("Choose plan").click();
  await expect(page.getByText("Choose")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Links on https://www.justicepathlaw.com/services: Start", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/services");
  await page.getByText("Start").click();
  await expect(page.getByText("Start")).toBeVisible();
});