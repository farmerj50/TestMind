import { test, expect } from '@playwright/test';

test('test', async ({ page }) => {
  await page.goto('https://www.justicepathlaw.com/');
  await page.getByRole('heading', { name: 'Guided Case Support' }).click();
  await page.getByText('🔒Your Privacy MattersYour').click();
  await page.getByRole('heading', { name: 'Smart Document Builder' }).click();
  await page.getByText('💬AI Legal AssistantAsk legal').click();
});