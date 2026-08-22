import { test, expect } from "@playwright/test";

test("Page loads: /signup", async ({ page }) => {
    await page.goto("https://www.bes-app.com/");
});
