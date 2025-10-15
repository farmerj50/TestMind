// apps/api/src/testmind/service.ts
import { TestPlan } from './core/plan';
import { scanRepoToPlan } from './core/scanner';
import { TestAdapter } from './core/adapter';
import { playwrightTSAdapter } from './adapters/playwright-ts/generator';
import { playwrightTSRunner } from './adapters/playwright-ts/runner';

type Runner = {
  id: string;
  install?(cwd: string): Promise<void>;
  run(cwd: string, env: Record<string, string>, onLine: (s: string) => void): Promise<number>;
};

const adapters: Record<string, { adapter: TestAdapter; runner: Runner }> = {
  'playwright-ts': { adapter: playwrightTSAdapter, runner: playwrightTSRunner },
  // 'cypress-js': { adapter: cypressAdapter, runner: cypressRunner },
  // 'cucumber-js': { adapter: cucumberAdapter, runner: cucumberRunner },
  // 'appium-js': { adapter: appiumAdapter, runner: appiumRunner },
};

export async function generateAndWrite({
  repoPath, outRoot, baseUrl, adapterId,
}: { repoPath: string; outRoot: string; baseUrl: string; adapterId: string }) {
  const entry = adapters[adapterId] ?? adapters['playwright-ts'];
  const { adapter } = entry;

  const plan: TestPlan = await scanRepoToPlan(repoPath, baseUrl);
  const files = adapter.render(plan);

  const fs = await import('fs');
  const path = await import('path');
  fs.mkdirSync(outRoot, { recursive: true });
  for (const f of files) {
    const full = path.join(outRoot, f.path);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, f.content, 'utf8');
  }

  return {
    manifest: adapter.manifest?.(plan) ?? { plan },
    outRoot,
  };
}

export async function runAdapter({
  outRoot, adapterId, env, onLine,
}: {
  outRoot: string;
  adapterId: string;
  env: Record<string, string>;
  onLine: (s: string) => void;
}) {
  const entry = adapters[adapterId] ?? adapters['playwright-ts'];
  const { runner } = entry;
  if (runner.install) await runner.install(outRoot);
  return runner.run(outRoot, env, onLine);
}
