import { test, expect } from '@playwright/test';

test("Smoke /assets/index-JuPOE-7C.css", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/assets/index-JuPOE-7C.css");
  await expect(page.getByText("Sign in")).toBeVisible();
  await expect(page.getByText("Dashboard")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Flow /assets/index-JuPOE-7C.css", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/assets/index-JuPOE-7C.css");
  await page.getByText("Sign in").click();
  await expect(page.getByText("Dashboard")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Route smoke: /assets/index-JuPOE-7C.css", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/assets/index-JuPOE-7C.css");
  await expect(page.getByText("Sign")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Links on /assets/index-JuPOE-7C.css: Sign in", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/assets/index-JuPOE-7C.css");
  await page.getByText("Sign in").click();
  await expect(page.getByText("Sign")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Links on /assets/index-JuPOE-7C.css: Sign up", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/assets/index-JuPOE-7C.css");
  await page.getByText("Sign up").click();
  await expect(page.getByText("Sign")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Links on /assets/index-JuPOE-7C.css: Pricing", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/assets/index-JuPOE-7C.css");
  await page.getByText("Pricing").click();
  await expect(page.getByText("Pricing")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Links on /assets/index-JuPOE-7C.css: Contact", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/assets/index-JuPOE-7C.css");
  await page.getByText("Contact").click();
  await expect(page.getByText("Contact")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Links on /assets/index-JuPOE-7C.css: Learn", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/assets/index-JuPOE-7C.css");
  await page.getByText("Learn").click();
  await expect(page.getByText("Learn")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Links on /assets/index-JuPOE-7C.css: Docs", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/assets/index-JuPOE-7C.css");
  await page.getByText("Docs").click();
  await expect(page.getByText("Docs")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Links on /assets/index-JuPOE-7C.css: Dashboard", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/assets/index-JuPOE-7C.css");
  await page.getByText("Dashboard").click();
  await expect(page.getByText("Dashboard")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Links on /assets/index-JuPOE-7C.css: Choose plan", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/assets/index-JuPOE-7C.css");
  await page.getByText("Choose plan").click();
  await expect(page.getByText("Choose")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Links on /assets/index-JuPOE-7C.css: Start", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/assets/index-JuPOE-7C.css");
  await page.getByText("Start").click();
  await expect(page.getByText("Start")).toBeVisible();
});