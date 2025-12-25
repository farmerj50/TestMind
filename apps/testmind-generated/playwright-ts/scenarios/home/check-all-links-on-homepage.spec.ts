import { test, expect } from '@playwright/test';

// Auto-generated for page / – 1 test(s)

test("Check All Links on Homepage", async ({ page }) => {
  test.info().annotations.push({ type: "parentSuite", description: "Testmind Generated Suite" }, { type: "suite", description: "/" }, { type: "story", description: "Check All Links on Homepage" }, { type: "parameter", description: "page=/" });
  await test.step("1. Navigate to https://justicepathlaw.com/", async () => {
    await page.goto("https://justicepathlaw.com/");
  });
  await test.step("2. Click link", async () => {
    {
      const locator = page.locator('a[href="https://www.justicepathlaw.com/"]').first();
      await locator.waitFor({ state: 'visible', timeout: 10000 });
      await locator.click({ timeout: 10000 });
    }
  });
  await test.step("3. Click link", async () => {
    {
      const locator = page.locator("link");
      await locator.waitFor({ state: 'visible', timeout: 10000 });
      await locator.click({ timeout: 10000 });
    }
  });
  await test.step("4. Click link", async () => {
    {
      const locator = page.locator("link");
      await locator.waitFor({ state: 'visible', timeout: 10000 });
      await locator.click({ timeout: 10000 });
    }
  });
  await test.step("5. Click link", async () => {
    {
      const locator = page.locator("link");
      await locator.waitFor({ state: 'visible', timeout: 10000 });
      await locator.click({ timeout: 10000 });
    }
  });
  await test.step("6. Click link", async () => {
    {
      const locator = page.locator("link");
      await locator.waitFor({ state: 'visible', timeout: 10000 });
      await locator.click({ timeout: 10000 });
    }
  });
  await test.step("7. Click link", async () => {
    {
      const locator = page.locator("link");
      await locator.waitFor({ state: 'visible', timeout: 10000 });
      await locator.click({ timeout: 10000 });
    }
  });
});
