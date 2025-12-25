import { defineConfig } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const DIR = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.TM_PORT ?? 4173);
const BASE = process.env.PW_BASE_URL || process.env.TM_BASE_URL || `http://localhost:${PORT}`;
const GEN_DIR = "D:\\Project\\testmind\\apps\\web\\testmind-generated\\playwright-ts-user_36fE7NhJd4BiVLk3EXpdpVh7J4m\\cmj1wj6sd00067knso9xj1473";
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

const FAST = (process.env.TM_FAST_MODE ?? "1") === "1";
const NAV_TIMEOUT = Number(process.env.TM_NAV_TIMEOUT_MS ?? (FAST ? "20000" : "20000"));
const ACTION_TIMEOUT = Number(process.env.TM_ACTION_TIMEOUT_MS ?? (FAST ? "20000" : "20000"));
const EXPECT_TIMEOUT = Number(process.env.TM_EXPECT_TIMEOUT_MS ?? (FAST ? "5000" : "8000"));
const TEST_TIMEOUT = Number(process.env.TM_TEST_TIMEOUT_MS ?? (FAST ? "30000" : "45000"));
const WORKERS = Number.isFinite(Number(process.env.TM_WORKERS))
  ? Number(process.env.TM_WORKERS)
  : 6;
const MAX_FAILURES = process.env.TM_MAX_FAILURES
  ? Number(process.env.TM_MAX_FAILURES)
  : 0;

export default defineConfig({
  use: {
    baseURL: BASE,
    navigationTimeout: NAV_TIMEOUT,
    actionTimeout: ACTION_TIMEOUT,
    trace: FAST ? 'off' : 'on-first-retry',
    video: FAST ? 'off' : 'retain-on-failure',
    screenshot: FAST ? 'off' : 'only-on-failure',
  },
  timeout: TEST_TIMEOUT,
  expect: { timeout: EXPECT_TIMEOUT },
  workers: WORKERS,
  fullyParallel: true,
  maxFailures: MAX_FAILURES,
  grep: GREP,
  reporter: reporters,
  webServer: undefined,
  testIgnore: [
    '**/node_modules/**',
    '**/dist/**',
    '**/build/**',
    '**/.*/**',
  ],
  projects: [{
    name: 'generated',
    testDir: GEN_DIR,
    testMatch: ['**/*.spec.ts','**/*.test.ts'],
    timeout: 30_000,
  }],
});