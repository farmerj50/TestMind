import { test, expect } from "@playwright/test";

test("Page loads: /case-type-selection", async ({ page }) => {
    await page.goto("https://www.bes-app.com/");
});
