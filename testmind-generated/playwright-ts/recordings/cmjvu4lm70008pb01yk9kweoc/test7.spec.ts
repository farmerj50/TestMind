import { test, expect } from '@playwright/test';

test('test7', async ({ page }) => {
  await page.goto('https://www.justicepathlaw.com/');
  await page.getByRole('heading', { name: 'AI Legal Assistant' }).click();
  await page.getByText('📄Smart Document BuilderBuild').click();
  await page.getByText('Your data stays secure. No').click();
});