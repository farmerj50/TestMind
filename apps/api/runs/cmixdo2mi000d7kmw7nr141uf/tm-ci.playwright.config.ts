
import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: '.',
  projects: [
    { name: 'gen-root', testDir: 'D:/Project/testmind/testmind-generated' },
    { name: 'gen-api',  testDir: 'D:/Project/testmind/apps/api/testmind-generated/playwright-ts' },
    { name: 'manual', testDir: 'D:/Project/testmind/apps/api/runs/cmixdo2mi000d7kmw7nr141uf/manual-specs' }
  ],
  reporter: 'html',
  use: { baseURL: process.env.TEST_BASE_URL || 'http://localhost:5173' },
});
