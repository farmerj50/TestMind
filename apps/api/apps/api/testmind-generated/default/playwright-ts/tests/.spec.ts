import { test, expect } from '@playwright/test';

test("Smoke /", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/");
  await expect(page.getByText("Sign in")).toBeVisible();
  await expect(page.getByText("Dashboard")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Smoke https://www.justicepathlaw.com/", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/");
  await expect(page.getByText("Sign in")).toBeVisible();
  await expect(page.getByText("Dashboard")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Flow /", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/");
  await page.getByText("Sign in").click();
  await expect(page.getByText("Dashboard")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Flow https://www.justicepathlaw.com/", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/");
  await page.getByText("Sign in").click();
  await expect(page.getByText("Dashboard")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("CTA 'Sign up' from /", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/");
  await page.getByText("Sign up").click();
  await expect(page.getByText("Sign")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("CTA 'Get started' from /", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/");
  await page.getByText("Get started").click();
  await expect(page.getByText("Get")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("CTA 'Choose plan' from /", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/");
  await page.getByText("Choose plan").click();
  await expect(page.getByText("Choose")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("CTA 'Contact' from /", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/");
  await page.getByText("Contact").click();
  await expect(page.getByText("Contact")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("CTA 'Sign in' from /", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/");
  await page.getByText("Sign in").click();
  await expect(page.getByText("Sign")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Route smoke: /", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/");
  await expect(page.getByText("Sign")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Navbar link: Home", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/");
  await page.getByText("Home").click();
  await expect(page.getByText("Home")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Navbar link: Pricing", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/");
  await page.getByText("Pricing").click();
  await expect(page.getByText("Pricing")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Navbar link: Contact", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/");
  await page.getByText("Contact").click();
  await expect(page.getByText("Contact")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Navbar link: Sign in", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/");
  await page.getByText("Sign in").click();
  await expect(page.getByText("Sign")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Navbar link: Sign up", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/");
  await page.getByText("Sign up").click();
  await expect(page.getByText("Sign")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Navbar link: Get started", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/");
  await page.getByText("Get started").click();
  await expect(page.getByText("Get")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Navbar link: Dashboard", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/");
  await page.getByText("Dashboard").click();
  await expect(page.getByText("Dashboard")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Links on /: Sign in", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/");
  await page.getByText("Sign in").click();
  await expect(page.getByText("Sign")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Links on /: Sign up", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/");
  await page.getByText("Sign up").click();
  await expect(page.getByText("Sign")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Links on /: Pricing", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/");
  await page.getByText("Pricing").click();
  await expect(page.getByText("Pricing")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Links on /: Contact", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/");
  await page.getByText("Contact").click();
  await expect(page.getByText("Contact")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Links on /: Learn", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/");
  await page.getByText("Learn").click();
  await expect(page.getByText("Learn")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Links on /: Docs", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/");
  await page.getByText("Docs").click();
  await expect(page.getByText("Docs")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Links on /: Dashboard", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/");
  await page.getByText("Dashboard").click();
  await expect(page.getByText("Dashboard")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Links on /: Choose plan", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/");
  await page.getByText("Choose plan").click();
  await expect(page.getByText("Choose")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Links on /: Start", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/");
  await page.getByText("Start").click();
  await expect(page.getByText("Start")).toBeVisible();
});