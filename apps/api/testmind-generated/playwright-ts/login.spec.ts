import { test, expect, Page } from '@playwright/test';

async function goToLogin(page: Page) {
  await page.goto('/');
  await page.getByRole('link', { name: /Sign in/i }).click(); // adjust selector if needed
  await page.waitForURL('**/continue', { timeout: 10_000 });
}

test.beforeEach(async ({ page }) => {
  await goToLogin(page);
});

test('Page loads: /login', async ({ page }) => {
  await expect(page).toHaveURL(/\/signin/);
  await expect(page.getByText('TestMind AI')).toBeVisible();
});

