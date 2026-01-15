import { test, expect } from '@playwright/test';

test('test20', async ({ page }) => {
  await page.goto('https://justicepathlaw.com/');
});