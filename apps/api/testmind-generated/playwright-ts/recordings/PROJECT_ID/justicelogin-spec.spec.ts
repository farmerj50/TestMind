import { test, expect } from '@playwright/test';

test('test', async ({ page }) => {
  await page.goto('https://www.justicepathlaw.com/');
  await page.getByRole('link', { name: 'Get Started' }).click();
  await page.getByRole('button', { name: '📄 Eviction For tenants' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('textbox', { name: 'Email Address' }).click();
  await page.getByRole('textbox', { name: 'Email Address' }).fill('johnfarmer43@gmail.com');
  await page.getByRole('textbox', { name: 'Password' }).click();
  await page.getByRole('textbox', { name: 'Password' }).fill('Ginslayer@15');
  await page.getByRole('button', { name: 'Login' }).click();
  await page.getByRole('link', { name: 'Pricing' }).nth(1).click();
  await page.getByRole('link', { name: 'Live Chat' }).nth(1).click();
});