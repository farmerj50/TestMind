// apps/api/src/testmind/service.ts

import type { TestPlan } from "./core/plan.js";
import { discoverSite } from "./discover.js";
import { generatePlan } from "./pipeline/generate-plan.js";
import { writeSpecsFromPlan } from "./pipeline/codegen.js";
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

const runner: Runner = playwrightTSRunner;

/**
 * Generate tests and write them to the output folder.
 * (Adapter params kept for compatibility but not used.)
 */
export async function generateAndWrite({
  repoPath,   // unused (kept for API compatibility)
  outRoot,
  baseUrl,
  adapterId,  // unused (kept for API compatibility)
}: {
  repoPath: string;
  outRoot: string;
  baseUrl: string;
  adapterId: string;
}) {
  const fs = await import("fs");
  const path = await import("path");

  // Clean output to avoid stale files
  if (fs.existsSync(outRoot)) {
    await fs.promises.rm(outRoot, { recursive: true, force: true });
  }
  await fs.promises.mkdir(outRoot, { recursive: true });

  // Build a plan (same flow as synthesize.ts)
  const env = { baseUrl };
  const component = { id: "repo", type: "UI" as const };
  const requirement = { id: "R1", title: "Generated plan", priority: "P1" as const };
  const risks = { likelihood: 0.3, impact: 0.5 };

  const discovered = await discoverSite(baseUrl);
  const patternInput = { component, requirement, risks, discovered, env };

  const plan: TestPlan = generatePlan(patternInput, "sdet");

  // Emit Playwright specs
  await writeSpecsFromPlan(outRoot, plan);

  return {
    manifest: { plan },
    outRoot,
  };
}

/**
 * Run the Playwright test runner.
 */
export async function runAdapter({
  outRoot,
  adapterId, // ignored
  env,
  onLine,
}: {
  outRoot: string;
  adapterId: string;
  env: Record<string, string>;
  onLine: (s: string) => void;
}) {
  if (runner.install) await runner.install(outRoot);
  return runner.run(outRoot, env, onLine);
}
