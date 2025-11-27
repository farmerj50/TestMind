import { test, expect } from '@playwright/test';

test('test', async ({ page }) => {
  await page.goto('https://www.justicepathlaw.com/');
  await page.getByRole('link', { name: 'Login' }).click();
  await page.getByRole('textbox', { name: 'Email Address' }).click();
  await page.getByRole('textbox', { name: 'Email Address' }).fill('johnfarmer43');
  await page.getByRole('textbox', { name: 'Email Address' }).press('ControlOrMeta+2');
  await page.getByRole('textbox', { name: 'Email Address' }).fill('johnfarmer43@gmail.com');
  await page.getByRole('textbox', { name: 'Password' }).click();
  await page.getByRole('textbox', { name: 'Password' }).fill('Ginslayer@30');
  await page.getByRole('button', { name: 'Login' }).click();
  await page.getByRole('button', { name: 'Login' }).click();
});