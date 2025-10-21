/// <reference types="node" />
import { defineConfig } from '@playwright/test';

export default defineConfig({
  use: {
    baseURL: process.env.PW_BASE_URL ?? 'http://localhost:4173',
    trace: 'on-first-retry',
  },
  webServer: {
    command: 'vite preview --port 4173',
    port: 4173,
    reuseExistingServer: true,
  },
});
