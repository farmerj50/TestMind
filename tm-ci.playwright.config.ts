// tm-ci.playwright.config.ts
import { defineConfig, devices } from "@playwright/test";
import path from "path";

const PORT = Number(process.env.TM_PORT ?? 5173);
const BASE = process.env.TM_BASE_URL ?? `http://localhost:${PORT}`;

export default defineConfig({
  // let Playwright scan the whole app; generated specs are under testmind-generated/
  testDir: ".",               // <-- back to simple . so it can see everything
  timeout: 30_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL: BASE,
    trace: "on-first-retry",
    video: "retain-on-failure",
    screenshot: "only-on-failure",
  },

  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],

  reporter: [["list"], ["html", { outputFolder: "playwright-report" }]],

  webServer: process.env.TM_SKIP_SERVER
    ? undefined
    : {
        command:
          process.platform === "win32"
            ? `powershell -NoProfile -Command "cd apps/web; pnpm install; pnpm dev --host localhost --port ${PORT} --strictPort"`
            : `bash -lc "cd apps/web && pnpm install && pnpm dev --host 0.0.0.0 --port ${PORT} --strictPort"`,
        url: `http://localhost:${PORT}`,
        reuseExistingServer: true,
        timeout: 120_000,
      },
});
