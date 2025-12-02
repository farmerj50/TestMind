import { test, expect } from '@playwright/test';

// Auto-generated for page /signup – 2 test(s)

test("Page loads: /signup", async ({ page }) => {
  test.info().annotations.push({ type: "parentSuite", description: "Testmind Generated Suite" }, { type: "suite", description: "/signup" }, { type: "story", description: "Page loads: /signup" }, { type: "parameter", description: "page=/signup" });
  await test.step("1. Navigate to https://bovada.lv/signup", async () => {
    await page.goto("https://bovada.lv/signup");
  });
  await test.step("2. Ensure text \"Sign\" is visible", async () => {
    await expect(page.getByText("Sign")).toBeVisible({ timeout: 10000 });
  });
});

test("Form submits – /signup", async ({ page }) => {
  test.info().annotations.push({ type: "parentSuite", description: "Testmind Generated Suite" }, { type: "suite", description: "/signup" }, { type: "story", description: "Form submits – /signup" }, { type: "parameter", description: "page=/signup" });
  await test.step("1. Navigate to https://bovada.lv/signup", async () => {
    await page.goto("https://bovada.lv/signup");
  });
  await test.step("2. Fill [name='g-recaptcha-response'], #g-recaptcha-response", async () => {
    {
      const locator = page.locator("[name='g-recaptcha-response'], #g-recaptcha-response");
      await locator.waitFor({ state: 'visible', timeout: 10000 });
      await locator.fill("Test value");
    }
  });
  await test.step("3. Click button[type='submit'], input[type='submit']", async () => {
    {
      const locator = page.locator("button[type='submit'], input[type='submit']");
      await locator.waitFor({ state: 'visible', timeout: 10000 });
      await locator.click({ timeout: 10000 });
    }
  });
  await test.step("4. Ensure text \"success\" is visible", async () => {
    await expect(page.getByText("success")).toBeVisible({ timeout: 10000 });
  });
});
