import { test, expect } from '@playwright/test';

// Auto-generated for page / – 1 test(s)

test("Verify Homepage Loads Successfully", async ({ page }) => {
  test.info().annotations.push({ type: "parentSuite", description: "Testmind Generated Suite" }, { type: "suite", description: "/" }, { type: "story", description: "Verify Homepage Loads Successfully" }, { type: "parameter", description: "page=/" });
  await test.step("1. Navigate to https://justicepathlaw.com/", async () => {
    await page.goto("https://justicepathlaw.com/");
  });
});
