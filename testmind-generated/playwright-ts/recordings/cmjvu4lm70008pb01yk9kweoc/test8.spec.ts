import { test, expect } from '@playwright/test';

test('test', async ({ page }) => {
  await page.goto('https://www.justicepathlaw.com/');
  await page.getByRole('heading', { name: 'Your Privacy Matters' }).click();
  await page.getByText('🧭Guided Case SupportStep-by-').click();
  await page.getByRole('heading', { name: 'Smart Document Builder' }).click();
  await page.getByRole('link', { name: 'Live Chat' }).click();
  await page.getByRole('button', { name: 'Enable microphone' }).click();
});