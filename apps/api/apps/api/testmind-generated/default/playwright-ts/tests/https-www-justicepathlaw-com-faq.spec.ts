import { test, expect } from '@playwright/test';

test("Route smoke: https://www.justicepathlaw.com/faq", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/faq");
  await expect(page.getByText("Sign")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Links on https://www.justicepathlaw.com/faq: Sign in", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/faq");
  await page.getByText("Sign in").click();
  await expect(page.getByText("Sign")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Links on https://www.justicepathlaw.com/faq: Sign up", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/faq");
  await page.getByText("Sign up").click();
  await expect(page.getByText("Sign")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Links on https://www.justicepathlaw.com/faq: Pricing", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/faq");
  await page.getByText("Pricing").click();
  await expect(page.getByText("Pricing")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Links on https://www.justicepathlaw.com/faq: Contact", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/faq");
  await page.getByText("Contact").click();
  await expect(page.getByText("Contact")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Links on https://www.justicepathlaw.com/faq: Learn", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/faq");
  await page.getByText("Learn").click();
  await expect(page.getByText("Learn")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Links on https://www.justicepathlaw.com/faq: Docs", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/faq");
  await page.getByText("Docs").click();
  await expect(page.getByText("Docs")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Links on https://www.justicepathlaw.com/faq: Dashboard", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/faq");
  await page.getByText("Dashboard").click();
  await expect(page.getByText("Dashboard")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Links on https://www.justicepathlaw.com/faq: Choose plan", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/faq");
  await page.getByText("Choose plan").click();
  await expect(page.getByText("Choose")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Links on https://www.justicepathlaw.com/faq: Start", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/faq");
  await page.getByText("Start").click();
  await expect(page.getByText("Start")).toBeVisible();
});