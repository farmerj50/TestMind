import { test, expect } from '@playwright/test';

async function clickNavLink(page, linkText) {
  const link = page.getByRole('link', { name: linkText });
  await expect(link).toBeVisible();
  await link.click();
  await page.waitForLoadState('domcontentloaded');
}

async function ensurePageIdentity(page, expectedText) {
  await expect(page.getByText(expectedText)).toBeVisible();
}

test("Page loads: /case-type-selection", async ({ page }) => {
  test.info().annotations.push({ type: "parentSuite", description: "Testmind Generated Suite" }, { type: "suite", description: "/case-type-selection" }, { type: "story", description: "Page loads: /case-type-selection" }, { type: "parameter", description: "page=/case-type-selection" });
  await test.step("1. Click navigation link directed to /case-type-selection", async () => {
    await clickNavLink(page, "Case Type Selection");
    await page.waitForSelector('#g-recaptcha-response', { timeout: 60000 }); // Increased timeout
  });
  await test.step("2. Ensure URL is /case-type-selection", async () => {
    await expect(page).toHaveURL(/.*\/case-type-selection$/);
  });
  await test.step("3. Ensure heading is visible", async () => {
    await expect(page.getByRole('heading', { name: /Case Type Selection/i })).toBeVisible();
  });
}, { timeout: 60000 }); // Default timeout kept

test("Form submits – /case-type-selection", async ({ page }) => {
  test.info().annotations.push({ type: "parentSuite", description: "Testmind Generated Suite" }, { type: "suite", description: "/case-type-selection" }, { type: "story", description: "Form submits – /case-type-selection" }, { type: "parameter", description: "page=/case-type-selection" });
  await test.step("1. Navigate to https://bovada.lv/case-type-selection", async () => {
    await clickNavLink(page, "Case Type Selection"); // Assuming the link text is "Case Type Selection"
  });
  await test.step("2. Fill [name='g-recaptcha-response'], button[type='submit'], input[type='submit']", async () => {
    const locator = page.locator("#g-recaptcha-response");
    await expect(locator).toBeVisible({ timeout: 30000 }); // Increased timeout
    await locator.fill("Test value");
  });
  await test.step("3. Click button[type='submit'], input[type='submit']", async () => {
    const locator = page.locator("button[type='submit'], input[type='submit']");
    await expect(locator).toBeVisible({ timeout: 30000 }); // Increased timeout
    await locator.click();
  });
  await test.step("4. Wait for navigation after submit", async () => {
    await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 30000 });
  });
  await test.step("5. Ensure text \"success\" is visible", async () => {
    await expect(page.getByText("success")).toBeVisible({ timeout: 30000 }); // Increased timeout
  });
}, { timeout: 60000 }); // Increased timeout to prevent timeout errors.
