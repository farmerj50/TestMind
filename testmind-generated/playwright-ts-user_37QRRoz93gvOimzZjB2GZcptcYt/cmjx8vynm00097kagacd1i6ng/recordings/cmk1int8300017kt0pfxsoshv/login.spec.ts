import { test, expect } from '@playwright/test';

test('test', async ({ page }) => {
  await page.goto('https://www.justicepathlaw.com/');
  await page.getByText('📄Smart Document BuilderBuild').click();
  await page.getByText('Your data stays secure. No').click();
});