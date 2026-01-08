import { test, expect } from '@playwright/test';

test('test4', async ({ page }) => {
  await page.goto('https://www.justicepathlaw.com/');
  await page.getByRole('heading', { name: 'Guided Case Support' }).click();
  await page.getByText('📄Smart Document BuilderBuild').click();
  await page.getByText('Your data stays secure. No').click();
});