import { test, expect } from "@playwright/test";

test("smoke", async ({ page }) => {
    await page.goto("https://www.bes-app.com/");
});
