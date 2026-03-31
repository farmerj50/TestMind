import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: process.env.TM_BASE_URL || "http://localhost:5173",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    storageState: process.env.E2E_EMAIL ? ".auth/state.json" : undefined
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  reporter: [["list"], ["html", { outputFolder: "playwright-report" }]],
  // if auth is configured, run the one-time setup before tests
  globalSetup: process.env.E2E_EMAIL ? "./auth.setup.ts" : undefined
});
