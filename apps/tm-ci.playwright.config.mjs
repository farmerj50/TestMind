import { defineConfig } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const DIR = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.TM_PORT ?? 4173);
const BASE = process.env.PW_BASE_URL || process.env.TM_BASE_URL || `http://localhost:${PORT}`;
const GEN_DIR = path.resolve(DIR, 'testmind-generated', 'playwright-ts');
const JSON_REPORT = process.env.PW_JSON_OUTPUT
  ? path.resolve(process.env.PW_JSON_OUTPUT)
  : path.resolve(DIR, 'playwright-report.json');
const ALLURE_RESULTS = process.env.PW_ALLURE_RESULTS
  ? path.resolve(process.env.PW_ALLURE_RESULTS)
  : path.resolve(DIR, 'allure-results');
const GREP = process.env.PW_GREP ? new RegExp(process.env.PW_GREP) : undefined;

const reporters = [
  ['list'],
  ['json', { outputFile: JSON_REPORT }],
  ['allure-playwright', { resultsDir: ALLURE_RESULTS }],
];

const DEV_COMMAND =
  process.platform === 'win32'
    ? `powershell -NoProfile -Command "& {Set-Location -Path 'D:\\Project\\testmind\\apps'; pnpm install; pnpm dev --host localhost --port 4173 }"`
    : `bash -lc "cd \"D:/Project/testmind/apps\" && pnpm install && pnpm dev --host 0.0.0.0 --port 4173"`;

const NAV_TIMEOUT = Number(process.env.TM_NAV_TIMEOUT_MS ?? "3000");
const ACTION_TIMEOUT = Number(process.env.TM_ACTION_TIMEOUT_MS ?? NAV_TIMEOUT);
const EXPECT_TIMEOUT = Number(process.env.TM_EXPECT_TIMEOUT_MS ?? "3000");
const TEST_TIMEOUT = Number(process.env.TM_TEST_TIMEOUT_MS ?? "10000");
const WORKERS = process.env.TM_WORKERS ? Number(process.env.TM_WORKERS) : undefined;
const MAX_FAILURES = process.env.TM_MAX_FAILURES ? Number(process.env.TM_MAX_FAILURES) : 0;

export default defineConfig({
  use: {
    baseURL: BASE,
    navigationTimeout: NAV_TIMEOUT,
    actionTimeout: ACTION_TIMEOUT,
    trace: 'on-first-retry',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  timeout: TEST_TIMEOUT,
  expect: { timeout: EXPECT_TIMEOUT },
  workers: WORKERS,
  maxFailures: MAX_FAILURES,
  grep: GREP,
  reporter: reporters,
  webServer: process.env.TM_SKIP_SERVER
    ? undefined
    : {
        command: DEV_COMMAND,
        url: `http://localhost:${PORT}`,
        reuseExistingServer: true,
        timeout: 120000,
      },
  testIgnore: [
    '**/node_modules/**',
    '**/dist/**',
    '**/build/**',
    '**/.*/**',
    '**/testmind-generated/appium-js/**', // skip appium stubs that require CommonJS
  ],
  projects: [{
    name: 'generated',
    testDir: GEN_DIR,
    testMatch: ['**/*.spec.ts','**/*.test.ts'],
    timeout: 30_000,
  }],
});