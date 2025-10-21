import fs from "fs/promises";
import path from "path";
import { execa } from "execa";

type Framework = "jest" | "vitest" | null;

export async function detectFramework(workdir: string): Promise<Framework> {
  const pkgPath = path.join(workdir, "package.json");
  let pkg: any;
  try { pkg = JSON.parse(await fs.readFile(pkgPath, "utf8")); } catch { return null; }

  const has = (dep: string) =>
    !!(pkg.dependencies?.[dep] || pkg.devDependencies?.[dep]);

  if (has("jest")) return "jest";
  if (has("vitest")) return "vitest";

  // Check scripts as a fallback
  const scr = pkg.scripts || {};
  if (/jest/.test(String(scr.test || ""))) return "jest";
  if (/vitest/.test(String(scr.test || ""))) return "vitest";
  return null;
}

export async function installDeps(workdir: string) {
  // prefer pnpm if lockfile exists; otherwise npm ci
  const hasPnpmLock = await exists(path.join(workdir, "pnpm-lock.yaml"));
  const hasNpmLock  = await exists(path.join(workdir, "package-lock.json"));
  if (hasPnpmLock) {
    await execa("pnpm", ["install", "--frozen-lockfile"], { cwd: workdir, env: { CI: "1" }, timeout: 12 * 60_000 });
  } else if (hasNpmLock) {
    await execa("npm", ["ci"], { cwd: workdir, env: { CI: "1" }, timeout: 12 * 60_000 });
  } else {
    await execa("npm", ["install", "--no-fund", "--no-audit"], { cwd: workdir, env: { CI: "1" }, timeout: 12 * 60_000 });
  }
}

async function exists(p: string) {
  try { await fs.stat(p); return true; } catch { return false; }
}

export type ExecResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  resultsPath?: string; // JSON output path if produced
};

export async function runTests(framework: Framework, workdir: string): Promise<ExecResult> {
  if (!framework) {
    return { ok: false, stdout: "", stderr: "No supported test framework detected (jest/vitest)" };
  }

  const resultsPath = path.join(workdir, "tm-results.json");

  if (framework === "jest") {
    const { stdout, stderr, exitCode } = await execa(
      "npx",
      ["jest", "--runInBand", "--testLocationInResults", "--json", `--outputFile=${resultsPath}`],
      { cwd: workdir, env: { CI: "1" }, timeout: 15 * 60_000 }
    );
    return { ok: exitCode === 0, stdout, stderr, resultsPath };
  }

  // vitest: json reporter to file
  const { stdout, stderr, exitCode } = await execa(
    "npx",
    ["vitest", "run", "--reporter=json", `--outputFile=${resultsPath}`],
    { cwd: workdir, env: { CI: "1" }, timeout: 15 * 60_000 }
  );
  return { ok: exitCode === 0, stdout, stderr, resultsPath };
}
