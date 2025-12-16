const { chromium } = require('@playwright/test');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto('https://justicepathlaw.com/pricing', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);
  const headings = await page.locator('h1, h2, h3').allTextContents();
  console.log('Headings:', headings.slice(0, 10));
  await browser.close();
})();
