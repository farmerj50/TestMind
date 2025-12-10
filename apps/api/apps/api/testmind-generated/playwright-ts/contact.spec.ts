import { test, expect } from '@playwright/test';

// Auto-generated for page /contact – 7 test(s)

test("Page loads: /contact", async ({ page }) => {
  test.info().annotations.push({ type: "parentSuite", description: "Testmind Generated Suite" }, { type: "suite", description: "/contact" }, { type: "story", description: "Page loads: /contact" }, { type: "parameter", description: "page=/contact" });
  await test.step("1. Navigate to /contact", async () => {
    await page.goto('/contact', { timeout: 60000 });
  });
  await test.step("2. Ensure text \"TestMind AI\" is visible", async () => {
    await page.waitForSelector('text=TestMind AI', { timeout: 60000 });
    await expect(page.locator('text=TestMind AI').first().first().first().first().first().first().first()).toBeVisible({ timeout: 60000 });
  });
});

test("Navigate /contact → /", async ({ page }) => {
  test.info().annotations.push({ type: "parentSuite", description: "Testmind Generated Suite" }, { type: "suite", description: "/contact" }, { type: "story", description: "Navigate /contact → /" }, { type: "parameter", description: "page=/contact" });
  await test.step("1. Navigate to /contact", async () => {
    await page.goto('/contact', { timeout: 60000 });
  });
  await test.step("2. Navigate to /", async () => {
    await page.goto('/', { timeout: 60000 });
  });
  await test.step("3. Ensure text \"Home\" is visible", async () => {
    await expect(page.getByText("Home", { exact: true })).toBeVisible({ timeout: 60000 });
  });
});

test("Navigate /contact → /pricing", async ({ page }) => {
  test.info().annotations.push({ type: "parentSuite", description: "Testmind Generated Suite" }, { type: "suite", description: "/contact" }, { type: "story", description: "Navigate /contact → /pricing" }, { type: "parameter", description: "page=/contact" });
  await test.step("1. Navigate to /contact", async () => {
    await page.goto('/contact', { timeout: 60000 });
  });
  await test.step("2. Navigate to /pricing", async () => {
    await page.goto('/pricing', { timeout: 60000 });
  });
  await test.step("3. Ensure text \"Pricing\" is visible", async () => {
    await expect(page.getByRole('link', { name: 'Pricing' })).toBeVisible({ timeout: 60000 });
  });
});

test("Navigate /contact → /signin", async ({ page }) => {
  test.info().annotations.push({ type: "parentSuite", description: "Testmind Generated Suite" }, { type: "suite", description: "/contact" }, { type: "story", description: "Navigate /contact → /signin" }, { type: "parameter", description: "page=/contact" });
  await test.step("1. Navigate to /contact", async () => {
    await page.goto('/contact', { timeout: 60000 });
  });
  await test.step("2. Navigate to /signin", async () => {
    await page.goto('/signin', { timeout: 60000 });
  });
  await test.step("3. Ensure text \"Sign In\" is visible", async () => {
    await page.waitForSelector('text=Sign In', { timeout: 60000 });
    await expect(page.getByText("Sign In", { exact: true })).toBeVisible({ timeout: 60000 });
  });
});

test("Navigate /contact → /signup", async ({ page }) => {
  test.info().annotations.push({ type: "parentSuite", description: "Testmind Generated Suite" }, { type: "suite", description: "/contact" }, { type: "story", description: "Navigate /contact → /signup" }, { type: "parameter", description: "page=/contact" });
  await test.step("1. Navigate to /contact", async () => {
    await page.goto('/contact', { timeout: 60000 });
  });
  await test.step("2. Navigate to /signup", async () => {
    await page.goto('/signup', { timeout: 60000 });
  });
  await test.step("3. Ensure text \"Test Signup\" is visible", async () => {
    await expect(page.getByText("Test Signup", { exact: true })).toBeVisible({ timeout: 60000 });
  });
});

test("Navigate /contact → /dashboard", async ({ page }) => {
  test.info().annotations.push({ type: "parentSuite", description: "Testmind Generated Suite" }, { type: "suite", description: "/contact" }, { type: "story", description: "Navigate /contact → /dashboard" }, { type: "parameter", description: "page=/contact" });
  await test.step("1. Navigate to /contact", async () => {
    await page.goto('/contact', { timeout: 60000 });
  });
  await test.step("2. Navigate to /dashboard", async () => {
    await page.goto('/dashboard', { timeout: 60000 });
  });
  await test.step("3. Ensure text \"Dashboard\" is visible", async () => {
    await expect(page.getByText("Dashboard", { exact: true })).toBeVisible({ timeout: 60000 });
  });
});

test("Navigate /contact → /suite/playwright-ts", async ({ page }) => {
  test.info().annotations.push({ type: "parentSuite", description: "Testmind Generated Suite" }, { type: "suite", description: "/contact" }, { type: "story", description: "Navigate /contact → /suite/playwright-ts" }, { type: "parameter", description: "page=/contact" });
  await test.step("1. Navigate to /contact", async () => {
    await page.goto('/contact', { timeout: 60000 });
  });
  await test.step("2. Navigate to /suite/playwright-ts", async () => {
    await page.goto('/suite/playwright-ts', { timeout: 60000 });
  });
  await test.step("3. Ensure text \"playwright-ts\" is visible", async () => {
    await page.waitForSelector('text=playwright-ts', { timeout: 60000 });
    await expect(page.getByText("playwright-ts", { exact: true })).toBeVisible({ timeout: 60000 });
  });
});

// New test for reports visibility

test("Ensure reports text is visible after navigating to /contact", async ({ page }) => {
  test.info().annotations.push({ type: "parentSuite", description: "Testmind Generated Suite" }, { type: "suite", description: "/contact" }, { type: "story", description: "Ensure reports text is visible after navigating to /contact" });
  await test.step("1. Navigate to /contact", async () => {
    await page.goto('/contact', { timeout: 60000 });
  });
  await test.step("2. Ensure text \"Reports\" is visible", async () => {
    await page.waitForSelector('text=Reports', { timeout: 60000 });
    await expect(page.getByText("Reports", { exact: true })).toBeVisible({ timeout: 60000 });
  });
});