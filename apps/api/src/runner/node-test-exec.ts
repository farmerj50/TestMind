import fs from "fs/promises";
import path from "path";
import { execa } from "execa";

type Framework = "jest" | "vitest" | "playwright" | null;

export async function detectFramework(workdir: string): Promise<Framework> {
  const pkgPath = path.join(workdir, "package.json");
  let pkg: any;
  try {
    pkg = JSON.parse(await fs.readFile(pkgPath, "utf8"));
  } catch {
    return null;
  }

  const has = (dep: string) =>
    !!(pkg.dependencies?.[dep] || pkg.devDependencies?.[dep]);

  // scripts must be available before we test them
  const scr = pkg.scripts || {};

  // ---- Playwright detection ----
  const hasPWDep = has("@playwright/test");
  const hasPWCfg =
    (await exists(path.join(workdir, "playwright.config.ts"))) ||
    (await exists(path.join(workdir, "playwright.config.js"))) ||
    (await exists(path.join(workdir, "playwright.config.mjs"))) ||
    (await exists(path.join(workdir, "playwright.config.cjs")));
  const hasPWScr =
    /playwright\s+test/.test(String(scr["test:e2e"] || "")) ||
    /playwright\s+test/.test(String(scr.test || ""));

  if (hasPWDep || hasPWCfg || hasPWScr) return "playwright";

  // ---- Jest / Vitest detection ----
  if (has("jest")) return "jest";
  if (has("vitest")) return "vitest";
  if (/jest/.test(String(scr.test || ""))) return "jest";
  if (/vitest/.test(String(scr.test || ""))) return "vitest";

  return null;
}

export async function installDeps(workdir: string) {
  const hasPnpmLock = await exists(path.join(workdir, "pnpm-lock.yaml"));
  const hasNpmLock = await exists(path.join(workdir, "package-lock.json"));
  if (hasPnpmLock) {
    await execa("pnpm", ["install", "--frozen-lockfile"], {
      cwd: workdir,
      env: { CI: "1" },
      timeout: 12 * 60_000,
    });
  } else if (hasNpmLock) {
    await execa("npm", ["ci"], {
      cwd: workdir,
      env: { CI: "1" },
      timeout: 12 * 60_000,
    });
  } else {
    await execa("npm", ["install", "--no-fund", "--no-audit"], {
      cwd: workdir,
      env: { CI: "1" },
      timeout: 12 * 60_000,
    });
  }
}

async function exists(p: string) {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

export type ExecResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  resultsPath?: string;
};

export async function runTests(
  framework: Framework,
  workdir: string
): Promise<ExecResult> {
  if (!framework) {
    return {
      ok: false,
      stdout: "",
      stderr:
        "No supported test framework detected (jest/vitest/playwright)",
    };
  }

  const resultsPath = path.join(workdir, "tm-results.json");

  // ---- Playwright ----
  if (framework === "playwright") {
    const { stdout, stderr, exitCode } = await execa(
      "npx",
      ["playwright", "test", "--reporter=json"],
      { cwd: workdir, env: { CI: "1" }, timeout: 30 * 60_000 }
    );
    try {
      await fs.writeFile(resultsPath, stdout, "utf8");
    } catch {}
    return { ok: exitCode === 0, stdout, stderr, resultsPath };
  }

  // ---- Jest ----
  if (framework === "jest") {
    const { stdout, stderr, exitCode } = await execa(
      "npx",
      ["jest", "--runInBand", "--testLocationInResults", "--json", `--outputFile=${resultsPath}`],
      { cwd: workdir, env: { CI: "1" }, timeout: 15 * 60_000 }
    );
    return { ok: exitCode === 0, stdout, stderr, resultsPath };
  }

  // ---- Vitest ----
  const { stdout, stderr, exitCode } = await execa(
    "npx",
    ["vitest", "run", "--reporter=json", `--outputFile=${resultsPath}`],
    { cwd: workdir, env: { CI: "1" }, timeout: 15 * 60_000 }
  );
  return { ok: exitCode === 0, stdout, stderr, resultsPath };
}
