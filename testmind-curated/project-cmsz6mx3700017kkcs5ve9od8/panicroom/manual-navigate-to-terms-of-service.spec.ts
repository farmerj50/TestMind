import { test, expect } from "@playwright/test";

test("Navigate to Terms of Service", async ({ page }) => {
    await page.goto("https://www.bes-app.com/\",\"route\":\"/\",\"specPath\":\"home.spec.ts\"}");
});
