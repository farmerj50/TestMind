const { chromium } = require('@playwright/test');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto('https://justicepathlaw.com/signup', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);
  const h2s = await page.locator('h2').allTextContents();
  console.log('H2:', h2s);
  console.log('Link Sign Up count:', await page.getByRole('link', { name: /Sign Up/i }).count());
  await browser.close();
})();
