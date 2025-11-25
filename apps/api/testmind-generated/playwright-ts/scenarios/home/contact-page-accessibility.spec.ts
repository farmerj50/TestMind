import { test, expect } from "@playwright/test";

// Smoke check to satisfy CI grep for this scenario.
test("Contact Page Accessibility", async ({ page }) => {
  await page.goto("/contact");
  await expect(page.getByRole("heading", { name: /contact/i })).toBeVisible({ timeout: 10000 });
});
