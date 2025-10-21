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

/** Try to get static routes from the repo (optional). */
async function getSeedRoutesFromRepo(repoPath: string): Promise<string[]> {
  try {
    // If you expose either of these from runtime/routes.ts (or routes.ts),
    // we’ll use them. Otherwise we just return [] and the crawler starts
    // from baseUrl and its first-page links.
    const mod = await import("./routes.js");
    if (typeof (mod as any).discoverRoutesFromRepo === "function") {
      const res = await (mod as any).discoverRoutesFromRepo(repoPath);
      return Array.isArray(res?.routes) ? res.routes : (Array.isArray(res) ? res : []);
    }
    if (typeof (mod as any).discoverRoutes === "function") {
      const res = await (mod as any).discoverRoutes(repoPath);
      return Array.isArray(res?.routes) ? res.routes : (Array.isArray(res) ? res : []);
    }
  } catch {
    // no static route helper available – that's okay
  }
  return [];
}

export interface GenerateOptions {
  include?: string;
  exclude?: string;
  maxRoutes?: number;
  authEmail?: string;
  authPassword?: string;
}

export async function generateAndWrite({
  repoPath,
  outRoot,
  baseUrl,
  adapterId, // kept for compatibility
  options = {},
}: {
  repoPath: string;
  outRoot: string;
  baseUrl: string;
  adapterId: string;
  options?: GenerateOptions;
}) {
  const { include, exclude, maxRoutes, authEmail, authPassword } = options;

  // Keep old env-based knobs working
  if (include) process.env.TM_INCLUDE = include;
  if (exclude) process.env.TM_EXCLUDE = exclude;
  if (maxRoutes) process.env.TM_MAX_ROUTES = String(maxRoutes);
  if (authEmail) process.env.E2E_EMAIL = authEmail;
  if (authPassword) process.env.E2E_PASS = authPassword;

  const fs = await import("fs");
  const path = await import("path");

  // Fresh output folder
  if (fs.existsSync(outRoot)) {
    await fs.promises.rm(outRoot, { recursive: true, force: true });
  }
  await fs.promises.mkdir(outRoot, { recursive: true });

  // 1) Try to get seed routes from repo (optional)
  const seedRoutes = await getSeedRoutesFromRepo(repoPath);

  // 2) Crawl the live site using those seeds (populates discovered.scans)
  const discovered = await discoverSite(baseUrl, seedRoutes);

  // 3) Build plan (now generatePlan gets the rich scans)
  const env = { baseUrl };
  const component = { id: "repo", type: "UI" as const };
  const requirement = { id: "R1", title: "Generated plan", priority: "P1" as const };
  const risks = { likelihood: 0.3, impact: 0.5 };
  const patternInput = { component, requirement, risks, discovered, env };

  const plan: TestPlan = generatePlan(patternInput, "sdet");

  // 4) Emit Playwright specs
  await writeSpecsFromPlan(outRoot, plan);

  return {
    manifest: { plan },
    outRoot,
  };
}

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
