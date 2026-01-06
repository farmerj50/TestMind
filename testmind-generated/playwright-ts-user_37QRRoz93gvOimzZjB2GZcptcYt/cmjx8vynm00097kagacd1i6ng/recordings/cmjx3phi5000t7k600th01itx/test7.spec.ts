import { test, expect } from '@playwright/test';

test('test', async ({ page }) => {
  await page.goto('https://justicepathlaw.com/');
  await page.getByText('💬').click();
  await page.locator('section').filter({ hasText: '💬AI Legal AssistantAsk legal' }).click();
  await page.getByText('🔒Your Privacy MattersYour').click();
});