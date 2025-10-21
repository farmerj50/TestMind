import { test as setup, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const STORAGE = path.join(__dirname, ".auth", "state.json");
const email = process.env.E2E_EMAIL;
const password = process.env.E2E_PASS;

setup("auth storage", async ({ page, baseURL }) => {
  if (!email || !password) return;
  await page.goto(`${baseURL}/sign-in`);
  await page.getByLabel(/email/i).fill(email);
  await page.getByLabel(/password/i).fill(password);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL(/dashboard|home|projects/i, { timeout: 20_000 });

  fs.mkdirSync(path.dirname(STORAGE), { recursive: true });
  await page.context().storageState({ path: STORAGE });
});
