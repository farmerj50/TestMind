import { Page, expect } from '@playwright/test';

export function attachErrorGuards(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (msg) => msg.type() === 'error' && errors.push(`console.error: ${msg.text()}`));
  page.on('response', (resp) => resp.status() >= 500 && errors.push(`http ${resp.status()} ${resp.url()}`));
  return () => errors;
}

export async function safeGoto(page: Page, url: string) {
  const r = await page.goto(url, { waitUntil: 'domcontentloaded' });
  expect(r, `goto ${url} failed`).not.toBeNull();
  expect(r!.ok(), `HTTP ${r?.status()} for ${url}`).toBeTruthy();
}
