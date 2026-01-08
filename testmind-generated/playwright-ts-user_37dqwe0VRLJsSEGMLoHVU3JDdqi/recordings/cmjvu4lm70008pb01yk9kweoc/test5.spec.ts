import { test, expect } from '@playwright/test';

test('test5', async ({ page }) => {
  await page.goto('https://www.justicepathlaw.com/');
  await page.getByText('🧭').click();
  await page.getByText('Your data stays secure. No').click();
  await page.getByText('Ask legal questions and get').click();
});