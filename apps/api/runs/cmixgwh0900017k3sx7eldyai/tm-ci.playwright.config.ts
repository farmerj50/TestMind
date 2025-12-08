
import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: '.',
  projects: [
    { name: 'manual', testDir: 'D:/Project/testmind/apps/api/runs/cmixgwh0900017k3sx7eldyai/manual-specs' }
  ],
  reporter: 'html',
  use: { baseURL: process.env.TEST_BASE_URL || 'http://localhost:5173' },
});
