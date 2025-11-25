import { test, expect } from "@playwright/test";

// Simple smoke to validate a primary action button on the home page.
test("Button Functionality Check", async ({ page }) => {
  await page.goto("/");

  // Adjust selector/text if your CTA differs.
  const button = page.getByRole("button", { name: /start|get started|run|submit/i });
  await expect(button).toBeVisible({ timeout: 10000 });

  // Click and assert some change; fallback to no-crash if no navigation/alert is expected.
  const [nav] = await Promise.all([
    page.waitForNavigation({ timeout: 5000 }).catch(() => null),
    button.click({ timeout: 10000 }),
  ]);

  // If no navigation, ensure button is still enabled/visible after click.
  if (!nav) {
    await expect(button).toBeEnabled({ timeout: 5000 });
  }
});
