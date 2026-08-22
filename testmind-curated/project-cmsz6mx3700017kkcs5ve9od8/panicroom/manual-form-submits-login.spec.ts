import { test, expect } from "@playwright/test";

test("Form submits – /login", async ({ page }) => {
    await page.goto("https://www.bes-app.com/\",\"route\":\"/login\",\"specPath\":\"login.spec.ts\"}");
});
