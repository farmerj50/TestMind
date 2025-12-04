import { test, expect } from '@playwright/test';

// Auto-generated for page /login – 2 test(s)

test("Page loads: /login", async ({ page }) => {
  test.info().annotations.push({ type: "parentSuite", description: "Testmind Generated Suite" }, { type: "suite", description: "/login" }, { type: "story", description: "Page loads: /login" }, { type: "parameter", description: "page=/login" });
  await test.step("1. Navigate to https://bovada.lv/login", async () => {
    await page.goto("https://bovada.lv/login");
  });
  await test.step("2. Ensure text \"Login and play Bitcoin casino games on your mobile device\" is visible", async () => {
    await expect(page.getByText("Login and play Bitcoin casino games on your mobile device")).toBeVisible({ timeout: 10000 });
  });
});

test("Form submits – /login", async ({ page }) => {
  test.info().annotations.push({ type: "parentSuite", description: "Testmind Generated Suite" }, { type: "suite", description: "/login" }, { type: "story", description: "Form submits – /login" }, { type: "parameter", description: "page=/login" });
  await test.step("1. Navigate to https://bovada.lv/login", async () => {
    await page.goto("https://bovada.lv/login");
  });
  await test.step("2. Fill [name='email'], #email", async () => {
    {
      const locator = page.locator("[name='email'], #email");
      await locator.waitFor({ state: 'visible', timeout: 10000 });
      await locator.fill("qa+auto@example.com");
    }
  });
  await test.step("3. Fill [name='login-password'], #login-password", async () => {
    {
      const locator = page.locator("[name='login-password'], #login-password");
      await locator.waitFor({ state: 'visible', timeout: 10000 });
      await locator.fill("P@ssw0rd1!");
    }
  });
  await test.step("4. Fill [name='remember-me'], #remember-me", async () => {
    {
      const locator = page.locator("[name='remember-me'], #remember-me");
      await locator.waitFor({ state: 'visible', timeout: 10000 });
      await locator.fill("Test value");
    }
  });
  await test.step("5. Fill [name='email'], #email", async () => {
    {
      const locator = page.locator("[name='email'], #email");
      await locator.waitFor({ state: 'visible', timeout: 10000 });
      await locator.fill("qa+auto@example.com");
    }
  });
  await test.step("6. Fill [name='login-password'], #login-password", async () => {
    {
      const locator = page.locator("[name='login-password'], #login-password");
      await locator.waitFor({ state: 'visible', timeout: 10000 });
      await locator.fill("P@ssw0rd1!");
    }
  });
  await test.step("7. Fill [name='remember-me'], #remember-me", async () => {
    {
      const locator = page.locator("[name='remember-me'], #remember-me");
      await locator.waitFor({ state: 'visible', timeout: 10000 });
      await locator.fill("Test value");
    }
  });
  await test.step("8. Fill [name='g-recaptcha-response'], #g-recaptcha-response", async () => {
    {
      const locator = page.locator("[name='g-recaptcha-response'], #g-recaptcha-response");
      await locator.waitFor({ state: 'visible', timeout: 10000 });
      await locator.fill("Test value");
    }
  });
  await test.step("9. Click button[type='submit'], input[type='submit']", async () => {
    {
      const locator = page.locator("button[type='submit'], input[type='submit']");
      await locator.waitFor({ state: 'visible', timeout: 10000 });
      await locator.click({ timeout: 10000 });
    }
  });
  await test.step("10. Ensure text \"success\" is visible", async () => {
    await expect(page.getByText("success")).toBeVisible({ timeout: 10000 });
  });
});
