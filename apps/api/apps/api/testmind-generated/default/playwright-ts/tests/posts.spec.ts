import { test, expect } from '@playwright/test';

test("Smoke https://www.justicepathlaw.com/posts", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/posts");
  await expect(page.getByText("Sign in")).toBeVisible();
  await expect(page.getByText("Dashboard")).toBeVisible();
});

import { test, expect } from '@playwright/test';

test("Flow https://www.justicepathlaw.com/posts", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/posts");
  await page.getByText("Sign in").click();
  await expect(page.getByText("Dashboard")).toBeVisible();
});