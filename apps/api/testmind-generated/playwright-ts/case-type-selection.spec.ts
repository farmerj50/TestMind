import { test, expect } from '@playwright/test';

// Auto-generated for page /case-type-selection — 1 test(s)

test("Page loads: /case-type-selection", async ({ page }) => {
  await page.goto("/case-type-selection");
  await expect(page.getByText("testmind-web")).toBeVisible();
});
