import { test, expect } from '@playwright/test';

async function clickSmart(page, s, v){ 
  try { if(s==='text') return await page.getByText(v,{exact:true}).first().click(); 
        if(s==='label') return await page.getByLabel(v).click();
        if(s==='role')  return await page.getByRole(v as any).click();
        return await page.click(v); } catch(e){}
  try { return await page.getByText(v).first().click(); } catch(e){}
  throw new Error('Self-heal failed: '+s+'='+v);
}
async function expectVisibleSmart(page, by, v){
  try { if(by==='text') return await expect(page.getByText(v)).toBeVisible();
        return await expect(page.locator(v)).toBeVisible(); } catch(e){}
  throw new Error('Expect failed: '+by+'='+v);
}

test("Smoke – home loads", async ({ page }) => {
  await page.goto("http://localhost:3000");
  await expectVisibleSmart(page,'text',"Sign in");
  await expectVisibleSmart(page,'text',"Dashboard");
});

test("Primary CTAs", async ({ page }) => {
  await page.goto("http://localhost:3000");
  await clickSmart(page,"text","Get started");
  await clickSmart(page,"text","Sign in");
  await clickSmart(page,"text","Sign up");
});
