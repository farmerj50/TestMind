
import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: '.',
  projects: [
    { name: 'gen-root', testDir: 'D:/Project/testmind/testmind-generated' },
    { name: 'gen-api',  testDir: 'D:/Project/testmind/apps/api/testmind-generated/playwright-ts' },
    { name: 'manual', testDir: 'D:/Project/testmind/apps/api/runs/cmixd8v3v000b7kmwhghj1245/manual-specs' }
  ],
  reporter: 'html',
  use: { baseURL: process.env.TEST_BASE_URL || 'http://localhost:5173' },
});
