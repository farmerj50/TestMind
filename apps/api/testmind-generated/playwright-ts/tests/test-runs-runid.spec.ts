import { test, expect } from '@playwright/test';

// Page: /test-runs/:runId — 1 tests
test("Route /test-runs/:runId loads", async ({ page }) => {
  await page.goto("https://www.justicepathlaw.com/test-runs/:runId");
  await expect(page.getByText("Sign")).toBeVisible();
});
