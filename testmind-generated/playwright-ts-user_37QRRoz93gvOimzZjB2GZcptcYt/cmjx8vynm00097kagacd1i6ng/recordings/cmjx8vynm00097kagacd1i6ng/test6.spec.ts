import { test, expect } from '@playwright/test';

test('test', async ({ page }) => {
  await page.goto('https://site.justicepath.com/');
  await page.getByRole('link', { name: 'logo' }).click();
  await page.locator('img').nth(4).click();
  await page.getByText('JusticePath gives clerks the').click();
});