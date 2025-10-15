import { test, expect } from '@playwright/test';
test("Primary CTAs", async ({ page }) => {
  await page.goto("http://localhost:3000");
  await page.goto("http://localhost:3000");
  await page.getByText("Get started", { exact: true }).first().click();
  await page.getByText("Sign in", { exact: true }).first().click();
  await page.getByText("Sign up", { exact: true }).first().click();
});
