import { test as setup } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const AUTH_STORAGE = process.env.TM_AUTH_STORAGE
  ? path.resolve(process.env.TM_AUTH_STORAGE)
  : path.join(DIR, "../../.auth/state.json");

setup("authenticate", async ({ page, baseURL }) => {
  const email = process.env.E2E_EMAIL;
  const password = process.env.E2E_PASS;
  if (!email || !password) return;

  await page.goto("/signin");

  // Dismiss cookie consent if present
  const cookieBtn = page.getByRole("button", { name: /accept|allow|agree|ok/i });
  if (await cookieBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await cookieBtn.click().catch(() => {});
  }

  await page.getByPlaceholder(/enter your email/i).fill(email);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByPlaceholder(/enter your password/i).fill(password);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.waitForURL(/dashboard|home|projects|qa-agent|app/i, { timeout: 30_000 });

  fs.mkdirSync(path.dirname(AUTH_STORAGE), { recursive: true });
  await page.context().storageState({ path: AUTH_STORAGE });
});
