import { test, expect } from '@playwright/test';

// Auto-generated for page / – 42 test(s)

test("Page loads: /", async ({ page }) => {
  test.info().annotations.push({ type: "parentSuite", description: "Testmind Generated Suite" }, { type: "suite", description: "/" }, { type: "story", description: "Page loads: /" }, { type: "parameter", description: "page=/:" });
  await test.step("1. Navigate to /", async () => {
    await page.goto("/");
    await page.waitForLoadState('domcontentloaded');
  });
  await test.step("2. Ensure text \"TestMind AI\" is visible", async () => {
    const locator = page.locator('text=TestMind AI');
    await expect(locator).toBeVisible();
  });
  await test.step("3. Ensure text \"Dashboard\" is visible", async () => {
    const locator = page.locator('text=Dashboard');
    await expect(locator).toBeVisible();
  });
  await test.step("4. Ensure text \"agent\" is visible", async () => {
    const locator = page.locator('text=agent');
    await expect(locator).toBeVisible();
  });
  await test.step("5. Ensure text \"Reports\" is visible", async () => {
    const locator = page.locator('text=Reports');
    await expect(locator).toBeVisible();
  });
  await test.step("6. Ensure text \"Recorder\" is visible", async () => {
    const locator = page.locator('text=Recorder');
    await expect(locator).toBeVisible();
  });
  await test.step("7. Ensure text \"Signup\" is visible", async () => {
    const locator = page.locator('text=Signup');  // Updated text to be case-sensitive
    await expect(locator).toBeVisible();
  });
  await test.step("8. Ensure text \"Integrations\" is visible", async () => {
    const locator = page.locator('text=Integrations');
    await expect(locator).toBeVisible();
  });
  await test.step("9. Ensure text \"testmind-web\" is visible", async () => {
    const locator = page.locator('text=testmind-web');
    await expect(locator).toBeVisible();
  });
  await test.step("10. Ensure text \"signin\" is visible", async () => {
    const locator = page.locator('text=signin');
    await expect(locator).toBeVisible();
  });
  await test.step("11. Ensure text \"pricing\" is visible", async () => {
    const locator = page.locator('text=pricing');
    await expect(locator).toBeVisible();
  });
  // Added step to check for 'playwright-ts'
  await test.step("12. Ensure text \"playwright-ts\" is visible", async () => {
    const locator = page.locator('text=playwright-ts');
    await expect(locator).toBeVisible();
  });
});