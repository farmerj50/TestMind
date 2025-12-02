// <reference types="@playwright/test" />

import { test, expect } from '@playwright/test';

test.use({ timeout: 60000 }); // Increase default timeout to 60 seconds

test("Page loads: /signin", async ({ page }) => {
  test.info().annotations.push({ type: "parentSuite", description: "Testmind Generated Suite" }, { type: "suite", description: "/signin" }, { type: "story", description: "Page loads: /signin" }, { type: "parameter", description: "page=/signin" });
  await test.step("1. Navigate to /signin", async () => {
    await page.goto("http://localhost:4173/signin", { waitUntil: 'domcontentloaded' });
  });
  await test.step("2. Ensure text \"TestMind AI\" is visible", async () => {
    const title = page.locator("text=TestMind AI");
    await expect(title).toBeVisible({ timeout: 20000 });
  });
});

test("Form submits – /signin", async ({ page }) => {
  test.info().annotations.push({ type: "parentSuite", description: "Testmind Generated Suite" }, { type: "suite", description: "/signin" }, { type: "story", description: "Form submits – /signin" }, { type: "parameter", description: "page=/signin" });
  await test.step("1. Navigate to /signin", async () => {
    await page.goto("http://localhost:4173/signin", { waitUntil: 'domcontentloaded' });
  });
  await test.step("2. Fill [name='identifier'], #identifier", async () => {
    const identifierInput = page.locator("[name='identifier'], #identifier");
    await expect(identifierInput).toBeVisible({ timeout: 20000 });
    await identifierInput.fill("Test value");
  });
  await test.step("3. Fill [name='password'], #password", async () => {
    const passwordInput = page.locator("[name='password'], #password");
    await expect(passwordInput).toBeVisible({ timeout: 20000 });
    await passwordInput.fill("P@ssw0rd1!");
  });
  await test.step("4. Click button[type='submit'], input[type='submit']", async () => {
    const submitButton = page.locator("button[type='submit'], input[type='submit']");
    await expect(submitButton).toBeVisible({ timeout: 20000 });
    await Promise.all([
      submitButton.click(),
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }),
    ]);
  });
  await test.step("5. Ensure text \"Success\" is visible", async () => {
    const successMessage = page.locator("text=Success");
    await expect(successMessage).toBeVisible({ timeout: 20000 });
  });
});

test("Validation blocks empty submission – /signin", async ({ page }) => {
  test.info().annotations.push({ type: "parentSuite", description: "Testmind Generated Suite" }, { type: "suite", description: "/signin" }, { type: "story", description: "Validation blocks empty submission – /signin" }, { type: "parameter", description: "page=/signin" });
  await test.step("1. Navigate to /signin", async () => {
    await page.goto("http://localhost:4173/signin", { waitUntil: 'domcontentloaded' });
  });
  await test.step("2. Click button[type='submit'], input[type='submit']", async () => {
    const submitButton = page.locator("button[type='submit'], input[type='submit']");
    await expect(submitButton).toBeVisible({ timeout: 20000 });
    await submitButton.click();
    await page.waitForTimeout(1000); // Adding brief wait to account for validations
  });
  await test.step("3. Ensure text \"Required\" is visible", async () => {
    const requiredMessage = page.locator("text=Required");
    await expect(requiredMessage).toBeVisible({ timeout: 20000 });
  });
});

test("Navigate /signin → /signup", async ({ page }) => {
  test.info().annotations.push({ type: "parentSuite", description: "Testmind Generated Suite" }, { type: "suite", description: "/signin" }, { type: "story", description: "Navigate /signin → /signup" }, { type: "parameter", description: "page=/signin" });
  await test.step("1. Navigate to /signin", async () => {
    await page.goto("http://localhost:4173/signin", { waitUntil: 'domcontentloaded' });
  });
  await test.step("2. Click link to /signup", async () => {
    const signupLink = page.locator("text=Signup");
    await expect(signupLink).toBeVisible({ timeout: 20000 });
    await signupLink.click();
    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 });
  });
  await test.step("3. Ensure text \"Signup\" is visible", async () => {
    const signupText = page.locator("text=Signup");
    await expect(signupText).toBeVisible({ timeout: 20000 });
  });
});