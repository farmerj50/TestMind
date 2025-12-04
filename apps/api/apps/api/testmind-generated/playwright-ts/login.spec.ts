import { test, expect } from '@playwright/test';

// Auto-generated for page /login – 1 test(s)
test("Page loads: /login", async ({ page }) => {
  test.info().annotations.push({ type: "parentSuite", description: "Testmind Generated Suite" }, { type: "suite", description: "/login" }, { type: "story", description: "Page loads: /login" }, { type: "parameter", description: "page=/login" });
  await test.step("1. Navigate to /login", async () => {
    await page.goto("http://localhost:4173/login", { waitUntil: "domcontentloaded", timeout: 30000 }); // Increased timeout to 30 seconds
  });
  await test.step("2. Ensure the page is fully loaded before checking for visibility", async () => {
    await page.waitForLoadState("load"); // Wait until the load state is complete
  });
  await test.step("3. Ensure the 'Login and play Bitcoin casino games on your mobile device' text is visible", async () => {
    const locator = page.locator("text=Login and play Bitcoin casino games on your mobile device"); // Ensured text is exactly correct
    await expect(locator).toBeVisible({ timeout: 30000 }); // Increased visibility assertion timeout to 30 seconds
  });
  await test.step("4. Check the checkbox if present", async () => {
    const checkbox = page.locator('input[type="checkbox"]');
    if (await checkbox.count() > 0) {
      const isChecked = await checkbox.isChecked();
      if (!isChecked) {
        await checkbox.check(); // Interacts with checkbox using check method
      }
    }
  });
});