import { test, expect } from '@playwright/test';

test("Smoke https://www.justicepathlaw.com/contact", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/contact");
  await expect(page.getByText("Sign in")).toBeVisible();
  await expect(page.getByText("Dashboard")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Flow https://www.justicepathlaw.com/contact", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/contact");
  await page.getByText("Sign in").click();
  await expect(page.getByText("Dashboard")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("CTA 'Sign up' from /contact", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/contact");
  await page.getByText("Sign up").click();
  await expect(page.getByText("Sign")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("CTA 'Get started' from /contact", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/contact");
  await page.getByText("Get started").click();
  await expect(page.getByText("Get")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("CTA 'Choose plan' from /contact", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/contact");
  await page.getByText("Choose plan").click();
  await expect(page.getByText("Choose")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("CTA 'Contact' from /contact", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/contact");
  await page.getByText("Contact").click();
  await expect(page.getByText("Contact")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("CTA 'Sign in' from /contact", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/contact");
  await page.getByText("Sign in").click();
  await expect(page.getByText("Sign")).toBeVisible();
});