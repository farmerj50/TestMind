import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests',
  use: {
    baseURL: process.env.TM_BASE_URL || "http://localhost:3000",
  },
  reporter: [['list']],
});