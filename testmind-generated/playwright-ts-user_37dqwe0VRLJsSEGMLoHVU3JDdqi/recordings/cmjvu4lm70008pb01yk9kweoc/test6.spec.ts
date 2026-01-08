import { test, expect } from '@playwright/test';

test('test6', async ({ page }) => {
  await page.goto('https://www.justicepathlaw.com/');
  await page.getByText('Your data stays secure. No').click();
  await page.getByRole('heading', { name: 'Guided Case Support' }).click();
});