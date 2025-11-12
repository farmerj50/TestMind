// tm-ci.playwright.config.ts
import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.TM_PORT ?? 5173);
const BASE = process.env.TM_BASE_URL ?? `http://localhost:${PORT}`;

export default defineConfig({
  testDir: '.',               // generated tests live in CWD
  timeout: 60_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL: BASE,            // supports TM_BASE_URL or falls back to http://localhost:PORT
    trace: 'on-first-retry',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],

  reporter: [['list'], ['html', { outputFolder: 'playwright-report' }]],

  // 🔑 start the app if it isn't already running
  webServer: process.env.TM_SKIP_SERVER ? undefined : {
    // change `apps/web` to your web app dir if different
    command: process.platform === 'win32'
      ? `powershell -NoProfile -Command "cd apps/web; pnpm build; pnpm preview --port ${PORT} --strictPort"`
      : `bash -lc "cd apps/web && pnpm build && pnpm preview --port ${PORT} --strictPort"`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
