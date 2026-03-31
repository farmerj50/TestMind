// tm-ci.playwright.config.ts
import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.TM_PORT ?? 5173);
const BASE = process.env.TM_BASE_URL ?? `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "testmind-generated",
  testMatch: [
    "**/playwright-ts*/**/*.spec.ts",
    "**/playwright-ts*/**/*.test.ts",
  ],
  timeout: 30_000,
  expect: { timeout: 10_000 },

  testIgnore: [
    "**/node_modules/**",
    "**/dist/**",
    "**/build/**",
    "**/.*/**",
    "**/testmind-generated/appium-js/**",
  ],

  use: {
    baseURL: BASE,
    trace: "on-first-retry",
    video: "retain-on-failure",
    screenshot: "only-on-failure",
  },

  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],

  reporter: [["list"], ["html", { outputFolder: "playwright-report" }]],

  webServer: process.env.TM_SKIP_SERVER
    ? undefined
    : {
      command:
        process.platform === "win32"
          ? `powershell -NoProfile -Command "cd apps/web; pnpm --filter testmind-web dev --host localhost --port ${PORT} --strictPort"`
          : `bash -lc "cd apps/web && pnpm --filter testmind-web dev --host 0.0.0.0 --port ${PORT} --strictPort"`,
        url: `http://localhost:${PORT}`,
        reuseExistingServer: true,
        timeout: 120_000,
      },
});
