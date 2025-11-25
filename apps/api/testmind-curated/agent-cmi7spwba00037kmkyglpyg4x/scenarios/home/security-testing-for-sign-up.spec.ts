import { test, expect } from '@playwright/test';

// Auto-generated for page / – 1 test(s)

test("Security Testing for Sign Up", async ({ page }) => {
  test.info().annotations.push({ type: "parentSuite", description: "Testmind Generated Suite" }, { type: "suite", description: "/" }, { type: "story", description: "Security Testing for Sign Up" }, { type: "parameter", description: "page=/" });
  await test.step("1. Navigate to http://localhost:5173/", async () => {
    await page.goto("http://localhost:5173/");
  });
});
