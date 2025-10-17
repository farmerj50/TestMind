// apps/api/src/testmind/service.ts

import type { TestPlan } from "./core/plan.js";
import { scanRepoToPlan } from "./core/scanner.js";
import type { TestAdapter } from "./core/adapter.js";
import { playwrightTSAdapter } from "./adapters/playwright-ts/generator.js";
import { playwrightTSRunner } from "./adapters/playwright-ts/runner.js";

type Runner = {
  id: string;
  install?(cwd: string): Promise<void>;
  run(
    cwd: string,
    env: Record<string, string>,
    onLine: (s: string) => void
  ): Promise<number>;
};

// Registry of supported adapters/runners
const adapters: Record<string, { adapter: TestAdapter; runner: Runner }> = {
  "playwright-ts": { adapter: playwrightTSAdapter, runner: playwrightTSRunner },
};

/**
 * Generate tests and write them to the adapter's output folder.
 * Cleans the outRoot first to avoid stale files.
 */
export async function generateAndWrite({
  repoPath,
  outRoot,
  baseUrl,
  adapterId,
}: {
  repoPath: string;
  outRoot: string;
  baseUrl: string;
  adapterId: string;
}) {
  const entry = adapters[adapterId] ?? adapters["playwright-ts"];
  const { adapter } = entry;

  // Clean output to avoid stale route_#.spec.ts files
  const fs = await import("fs");
  if (fs.existsSync(outRoot)) {
    await fs.promises.rm(outRoot, { recursive: true, force: true });
  }

  // Build plan + render files
  const plan: TestPlan = await scanRepoToPlan(repoPath, baseUrl);
  const files = adapter.render(plan);

  // Write files
  const path = await import("path");
  await fs.promises.mkdir(outRoot, { recursive: true });
  for (const f of files) {
    const full = path.join(outRoot, f.path);
    await fs.promises.mkdir(path.dirname(full), { recursive: true });
    await fs.promises.writeFile(full, f.content, "utf8");
  }

  return {
    manifest: adapter.manifest?.(plan) ?? { plan },
    outRoot,
  };
}

/**
 * Run the adapter's test runner (Playwright, etc.)
 */
export async function runAdapter({
  outRoot,
  adapterId,
  env,
  onLine,
}: {
  outRoot: string;
  adapterId: string;
  env: Record<string, string>;
  onLine: (s: string) => void;
}) {
  const entry = adapters[adapterId] ?? adapters["playwright-ts"];
  const { runner } = entry;
  if (runner.install) await runner.install(outRoot);
  return runner.run(outRoot, env, onLine);
}
