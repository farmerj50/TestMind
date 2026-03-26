import { test as setup } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const DIR = typeof __dirname !== "undefined" ? __dirname : path.dirname(fileURLToPath(import.meta.url));
export const AUTH_STORAGE = process.env.TM_AUTH_STORAGE
  ? path.resolve(process.env.TM_AUTH_STORAGE)
  : path.join(DIR, ".auth", "state.json");
const email = process.env.E2E_EMAIL;
const password = process.env.E2E_PASS;
const loginPath = process.env.TM_LOGIN_PATH || "/login";
setup("auth storage", async ({ page, baseURL }) => {
  if (!email || !password) return;
  const loginUrl = loginPath.startsWith("http") ? loginPath : `${baseURL}${loginPath}`;
  await page.goto(loginUrl);
  const cookieBtn = page.getByRole("button", { name: /accept|allow|agree|ok/i });
  if (await cookieBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    await cookieBtn.click().catch(() => {});
  }
  await page.getByLabel(/email|username|user/i).first().fill(email);
  await page.getByLabel(/password/i).first().fill(password);
  await page.getByRole("button", { name: /sign.?in|log.?in|submit|continue/i }).click();
  await page.waitForURL(/dashboard|home|portfolio|feed|account|app/i, { timeout: 30_000 }).catch(() => {});
  fs.mkdirSync(path.dirname(AUTH_STORAGE), { recursive: true });
  await page.context().storageState({ path: AUTH_STORAGE });
});
