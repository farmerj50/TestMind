/**
 * Playwright config for TestMind journey tests.
 *
 * Tests the app end-to-end through the browser — not generated specs.
 * Targets the running dev or preview server.
 *
 * Usage:
 *   E2E_EMAIL=... E2E_PASS=... npx playwright test --config tm-journey.playwright.config.ts
 *
 * With an existing server:
 *   TM_SKIP_SERVER=1 TM_BASE_URL=http://localhost:5173 npx playwright test --config tm-journey.playwright.config.ts
 */

import { defineConfig, devices } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.TM_PORT ?? 5173);
const BASE = process.env.TM_BASE_URL ?? `http://localhost:${PORT}`;

const HAS_AUTH = Boolean(process.env.E2E_EMAIL && process.env.E2E_PASS);
const AUTH_STORAGE = process.env.TM_AUTH_STORAGE
  ? path.resolve(process.env.TM_AUTH_STORAGE)
  : path.join(DIR, ".auth", "state.json");

export default defineConfig({
  testDir: path.join(DIR, "tests", "journeys"),
  testMatch: ["**/*.spec.ts"],

  timeout: 60_000,
  expect: { timeout: 15_000 },

  // Run journeys serially — each test starts a real QA job and we don't want
  // concurrency inflating DB state or confusing the polling assertions.
  workers: 1,
  fullyParallel: false,
  retries: 0,

  use: {
    baseURL: BASE,
    trace: "on-first-retry",
    video: "retain-on-failure",
    screenshot: "only-on-failure",
    navigationTimeout: 30_000,
    actionTimeout: 15_000,
  },

  reporter: [
    ["list"],
    ["html", { outputFolder: "journey-report", open: "never" }],
  ],

  projects: [
    // Auth setup project — runs once and stores session to .auth/state.json
    ...(HAS_AUTH
      ? [
          {
            name: "auth-setup",
            testMatch: /auth\.setup\.mjs/,
            testDir: path.join(DIR, "tests", "journeys"),
          },
        ]
      : []),

    {
      name: "journey",
      use: {
        ...devices["Desktop Chrome"],
        ...(HAS_AUTH ? { storageState: AUTH_STORAGE } : {}),
      },
      ...(HAS_AUTH ? { dependencies: ["auth-setup"] } : {}),
    },
  ],

  webServer: process.env.TM_SKIP_SERVER
    ? undefined
    : {
        command:
          process.platform === "win32"
            ? `powershell -NoProfile -Command "pnpm --filter testmind-web dev --host localhost --port ${PORT} --strictPort"`
            : `pnpm --filter testmind-web dev --host 0.0.0.0 --port ${PORT} --strictPort`,
        url: BASE,
        reuseExistingServer: true,
        timeout: 120_000,
      },
});
