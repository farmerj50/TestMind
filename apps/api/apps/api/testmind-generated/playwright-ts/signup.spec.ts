import { test, expect } from '@playwright/test';

// Auto-generated for page /signup – 63 test(s)

const baseUrl = process.env.BASE_URL || 'http://localhost:3000'; // Updated port for connection

test("Page loads: /signup", { timeout: 60000 }, async ({ page }) => {
  test.info().annotations.push({ type: "parentSuite", description: "Testmind Generated Suite" }, { type: "suite", description: "/signup" }, { type: "story", description: "Page loads: /signup" }, { type: "parameter", description: "page=/signup" });
  await test.step("1. Navigate to /signup", async () => {
    await page.goto(`${baseUrl}/signup`);
    await page.waitForLoadState('load', { timeout: 20000 }); // Ensure the page is fully loaded
    await page.waitForTimeout(1000); // Small wait for stability
    await page.waitForNetworkIdle({ timeout: 20000 }); // Wait for network to be idle
  });
  await test.step("2. Ensure text \"testmind-web\" is visible", async () => {
    const element = page.locator("text=testmind-web");
    await expect(element).toBeVisible({ timeout: 5000 }); // Set a timeout to ensure it has time to load
  });
});

test("Form submits – /signup", { timeout: 60000 }, async ({ page }) => {
  test.info().annotations.push({ type: "parentSuite", description: "Testmind Generated Suite" }, { type: "suite", description: "/signup" }, { type: "story", description: "Form submits – /signup" }, { type: "parameter", description: "page=/signup" });
  await test.step("1. Navigate to /signup", async () => {
    await page.goto(`${baseUrl}/signup`);
    await page.waitForLoadState('load', { timeout: 20000 }); // Ensure the page is fully loaded
    await page.waitForTimeout(1000);
    await page.waitForNetworkIdle({ timeout: 20000 });
  });
  await test.step("2. Fill [name='firstName'], #firstName", async () => {
    const firstNameField = page.locator("[name='firstName'], #firstName");
    await expect(firstNameField).toBeVisible({ timeout: 5000 }); // Set a timeout to ensure it has time to load
    await firstNameField.fill("QA Auto");
  });
  await test.step("3. Fill [name='lastName'], #lastName", async () => {
    const lastNameField = page.locator("[name='lastName'], #lastName");
    await expect(lastNameField).toBeVisible({ timeout: 5000 }); // Set a timeout to ensure it has time to load
    await lastNameField.fill("QA Auto");
  });
  await test.step("4. Fill [name='emailAddress'], #emailAddress", async () => {
    const emailField = page.locator("[name='emailAddress'], #emailAddress");
    await expect(emailField).toBeVisible({ timeout: 5000 }); // Set a timeout to ensure it has time to load
    await emailField.fill("qa+auto@example.com");
  });
  await test.step("5. Fill [name='password'], #password", async () => {
    const passwordField = page.locator("[name='password'], #password");
    await expect(passwordField).toBeVisible({ timeout: 5000 }); // Set a timeout to ensure it has time to load
    await passwordField.fill("P@ssw0rd1!");
  });
  await test.step("6. Click button[type='submit'], input[type='submit']", async () => {
    const submitButton = page.locator("button[type='submit'], input[type='submit']");
    await expect(submitButton).toBeVisible({ timeout: 5000 }); // Set a timeout to ensure it has time to load
    await submitButton.click();
  });
  await test.step("7. Ensure text \"success\" is visible", async () => {
    const element = page.locator("text=success");
    await expect(element).toBeVisible({ timeout: 5000 }); // Set a timeout to ensure it has time to load
  });
});

test("Validation blocks empty submission – /signup", { timeout: 60000 }, async ({ page }) => {
  test.info().annotations.push({ type: "parentSuite", description: "Testmind Generated Suite" }, { type: "suite", description: "/signup" }, { type: "story", description: "Validation blocks empty submission – /signup" }, { type: "parameter", description: "page=/signup" });
  await test.step("1. Navigate to /signup", async () => {
    await page.goto(`${baseUrl}/signup`);
    await page.waitForLoadState('load', { timeout: 20000 }); // Ensure the page is fully loaded
    await page.waitForTimeout(1000);
    await page.waitForNetworkIdle({ timeout: 20000 });
  });
  await test.step("2. Click button[type='submit'], input[type='submit']", async () => {
    const submitButton = page.locator("button[type='submit'], input[type='submit']");
    await expect(submitButton).toBeVisible({ timeout: 5000 }); // Set a timeout to ensure it has time to load
    await submitButton.click();
  });
  await test.step("3. Ensure text \"required\" is visible", async () => {
    const element = page.locator("text=required");
    await expect(element).toBeVisible({ timeout: 5000 }); // Set a timeout to ensure it has time to load
  });
});