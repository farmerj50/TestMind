import { test, expect } from '@playwright/test';

test("Route smoke: https://www.justicepathlaw.com/signup", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/signup");
  await expect(page.getByText("Sign")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Links on https://www.justicepathlaw.com/signup: Sign in", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/signup");
  await page.getByText("Sign in").click();
  await expect(page.getByText("Sign")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Links on https://www.justicepathlaw.com/signup: Sign up", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/signup");
  await page.getByText("Sign up").click();
  await expect(page.getByText("Sign")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Links on https://www.justicepathlaw.com/signup: Pricing", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/signup");
  await page.getByText("Pricing").click();
  await expect(page.getByText("Pricing")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Links on https://www.justicepathlaw.com/signup: Contact", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/signup");
  await page.getByText("Contact").click();
  await expect(page.getByText("Contact")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Links on https://www.justicepathlaw.com/signup: Learn", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/signup");
  await page.getByText("Learn").click();
  await expect(page.getByText("Learn")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Links on https://www.justicepathlaw.com/signup: Docs", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/signup");
  await page.getByText("Docs").click();
  await expect(page.getByText("Docs")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Links on https://www.justicepathlaw.com/signup: Dashboard", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/signup");
  await page.getByText("Dashboard").click();
  await expect(page.getByText("Dashboard")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Links on https://www.justicepathlaw.com/signup: Choose plan", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/signup");
  await page.getByText("Choose plan").click();
  await expect(page.getByText("Choose")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Links on https://www.justicepathlaw.com/signup: Start", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/signup");
  await page.getByText("Start").click();
  await expect(page.getByText("Start")).toBeVisible();
});