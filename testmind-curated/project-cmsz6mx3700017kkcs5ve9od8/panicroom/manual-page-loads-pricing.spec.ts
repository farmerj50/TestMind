import { test, expect } from "@playwright/test";

test("Page loads: /pricing", async ({ page }) => {
    await page.goto("https://www.bes-app.com/");
});
