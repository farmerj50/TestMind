import { test, expect } from '@playwright/test';

// Auto-generated for page /login – 1 test(s)

test("Page loads: /login", async ({ page }) => {
  test.info().annotations.push({ type: "parentSuite", description: "Testmind Generated Suite" }, { type: "suite", description: "/login" }, { type: "story", description: "Page loads: /login" }, { type: "parameter", description: "page=/login" });
  await test.step("1. Navigate to /login", async () => {
    await page.goto("/login", { waitUntil: "domcontentloaded", timeout: 60000 }); // Changed to 'domcontentloaded' for quicker response
  });
  await test.step("2. Ensure text \"testmind-web\" is visible", async () => {
    const locator = page.locator("text=testmind-web"); // Ensured proper targeting
    await expect(locator).toBeVisible({timeout: 10000}); // Combined visibility check with timeout directly into the assertion
  });
  await test.step("3. Check the checkbox if present", async () => {
    const checkbox = page.locator('input[type="checkbox"]');
    if (await checkbox.count() > 0) {
      await checkbox.check(); // Interacts with checkbox instead of fill
    }
  });
});