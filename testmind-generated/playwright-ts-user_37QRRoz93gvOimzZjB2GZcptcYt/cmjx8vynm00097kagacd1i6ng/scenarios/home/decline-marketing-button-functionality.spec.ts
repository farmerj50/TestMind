import { test, expect } from '@playwright/test';

// Auto-generated for page / – 1 test(s)

test("Decline Marketing Button Functionality", async ({ page }) => {
  test.info().annotations.push({ type: "parentSuite", description: "Testmind Generated Suite" }, { type: "suite", description: "/" }, { type: "story", description: "Decline Marketing Button Functionality" }, { type: "parameter", description: "page=/" });
  // Updated nav: correct domain and longer timeout for heavy landing page
  await page.goto("https://www.bovada.lv/", { waitUntil: "domcontentloaded" });
  await test.step("1. Decline marketing / cookies prompt", async () => {
    // TODO: replace with the real selector from the banner/prompt
    // Example guess for a decline/close button:
    const decline = page.getByRole("button", { name: /decline|no thanks|reject/i });
    await decline.waitFor({ state: "visible", timeout: 8000 });
    await decline.click();
  });
});
