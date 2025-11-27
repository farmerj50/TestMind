import { test, expect } from '@playwright/test';

test('check links', async ({ page }) => {
    // Set a longer timeout for this test case
    test.setTimeout(60000);

    await page.goto('https://example.com');

    const links = await page.$$('a');
    for (const link of links) {
        const href = await link.getAttribute('href');
        const response = await page.goto(href);
        expect(response.ok()).toBeTruthy();
    }
});