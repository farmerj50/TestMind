import { test, expect } from '@playwright/test';

// Auto-generated for page / – 2 test(s)

test("Page loads: /", async ({ page }) => {
  test.info().annotations.push({ type: "parentSuite", description: "Testmind Generated Suite" }, { type: "suite", description: "" }, { type: "story", description: "Page loads: /" }, { type: "parameter", description: "page=/<" });
  await test.step("1. Navigate to https://bovada.lv/", async () => {
    await page.goto("https://bovada.lv/");
  });
  await test.step("2. Ensure text \"Bovada | Online Sportsbook, Casino, and Poker\" is visible", async () => {
    await page.waitForSelector("text='Bovada | Online Sportsbook, Casino, and Poker'", { timeout: 10000 });
    await expect(page.getByText("Bovada | Online Sportsbook, Casino, and Poker")).toBeVisible({ timeout: 10000 });
  });
});

test("Form submits – /", async ({ page }) => {
  test.info().annotations.push({ type: "parentSuite", description: "Testmind Generated Suite" }, { type: "suite", description: "" }, { type: "story", description: "Form submits – /" }, { type: "parameter", description: "page=/<" });
  await test.step("1. Navigate to https://bovada.lv/", async () => {
    await page.goto("https://bovada.lv/");
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
