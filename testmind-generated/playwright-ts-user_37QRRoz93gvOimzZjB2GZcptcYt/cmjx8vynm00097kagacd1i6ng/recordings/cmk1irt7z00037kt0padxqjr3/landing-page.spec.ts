import { test, expect } from '@playwright/test';

test('test', async ({ page }) => {
  await page.goto('https://www.justicepathlaw.com/');
  await page.getByText('💬').click();
  await page.getByRole('heading', { name: 'Smart Document Builder' }).click();
  await page.getByRole('heading', { name: 'Guided Case Support' }).click();
});