// apps/web/playwright.config.ts
import { defineConfig } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WEB = __dirname;

// Try multiple locations for generated specs:
//  - copied into the temp workdir: apps/web/generated-specs
//  - original repo root via env TM_SOURCE_ROOT: <repo>/testmind-generated/playwright-ts
//  - sibling relative hop (in case runner copies parent)
const candidates = [
  path.resolve(WEB, 'generated-specs'),
  process.env.TM_SOURCE_ROOT
    ? path.resolve(process.env.TM_SOURCE_ROOT, 'testmind-generated', 'playwright-ts')
    : undefined,
  path.resolve(WEB, '..', '..', 'testmind-generated', 'playwright-ts'),
].filter(Boolean) as string[];

const GEN = candidates.find(p => fs.existsSync(p));

export default defineConfig({
  reporter: [['json']],
  webServer: { command: 'vite dev --host 0.0.0.0 --port 4173', port: 4173, reuseExistingServer: true },
  use: { baseURL: 'http://localhost:4173' },
  projects: [
    { name: 'web', testDir: WEB, testMatch: ['**/*.spec.ts', '**/*.test.ts'], timeout: 30_000 },
    ...(GEN
      ? [{ name: 'generated', testDir: GEN, testMatch: ['**/*.spec.ts', '**/*.test.ts'], timeout: 30_000 }]
      : []),
  ],
  
});
