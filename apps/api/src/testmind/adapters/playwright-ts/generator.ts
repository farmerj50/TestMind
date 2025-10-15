// apps/api/src/testmind/adapters/playwright-ts/generator.ts
import { TestPlan } from '../../core/plan';
import { TestAdapter, RenderedFile } from '../../core/adapter';

const header = `import { test, expect } from '@playwright/test';\n`;

function renderCase(c: any, baseUrl: string) {
  const lines: string[] = [];
  lines.push(`test(${JSON.stringify(c.title || c.id)}, async ({ page }) => {`);

  // start from base
  lines.push(`  await page.goto(${JSON.stringify(baseUrl)});`);

  for (const s of c.steps || []) {
    if (s.kind === 'goto') {
      lines.push(`  await page.goto(${JSON.stringify(s.url)});`);
    } else if (s.kind === 'click' && s.by === 'text') {
      lines.push(
        `  await page.getByText(${JSON.stringify(s.value)}, { exact: true }).first().click();`
      );
    } else if (s.kind === 'expectVisible' && s.by === 'text') {
      lines.push(
        `  await expect(page.getByText(${JSON.stringify(s.value)})).toBeVisible();`
      );
    }
  }

  lines.push(`});`);
  return header + lines.join('\n') + '\n';
}

export const playwrightTSAdapter: TestAdapter = {
  id: 'playwright-ts',
  displayName: 'Playwright (TypeScript)',

  render(plan: TestPlan): RenderedFile[] {
    const files: RenderedFile[] = [];

    // --- one spec per case ---
    for (const c of plan.cases || []) {
      const safe =
        (c.id || c.title || 'case')
          .toString()
          .toLowerCase()
          .replace(/[^a-z0-9_-]/g, '_') || 'case';
      files.push({
        path: `tests/${safe}.spec.ts`,
        content: renderCase(c, plan.baseUrl),
      });
    }

    // playwright config
    files.push({
      path: 'playwright.config.ts',
      content: `
import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests',
  use: {
    baseURL: process.env.TM_BASE_URL || ${JSON.stringify(plan.baseUrl)},
  },
  reporter: [['list']],
});`.trim(),
    });

    // package.json for local run
    files.push({
      path: 'package.json',
      content: JSON.stringify(
        {
          name: 'tm-playwright-ts',
          private: true,
          type: 'module',
          scripts: { 'test:pw': 'npx playwright test -c playwright.config.ts' },
          devDependencies: { '@playwright/test': '^1.47.2' },
        },
        null,
        2
      ),
    });

    return files;
  },

  manifest(plan: TestPlan) {
    return { plan };
  },
};
