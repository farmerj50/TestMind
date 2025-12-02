import { test, expect } from '@playwright/test';

// Auto-generated for page / – 1 test(s)

test("reCAPTCHA Field Required Validation", async ({ page }) => {
  test.info().annotations.push({ type: "parentSuite", description: "Testmind Generated Suite" }, { type: "suite", description: "/" }, { type: "story", description: "reCAPTCHA Field Required Validation" }, { type: "parameter", description: "page=/" });
  await test.step("1. Navigate to https://bovada.lv/", async () => {
    await page.goto("https://bovada.lv/");
  });
});
