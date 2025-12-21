// apps/api/src/testmind/adapters/cypress-js/runner.ts
import path from "node:path";
import fs from "node:fs";
import { execa } from "execa";
import type { TestRunner } from "../../core/adapter.js";

function findConfig(cwd: string) {
  const candidates = [
    path.join(cwd, "testmind-generated", "cypress-js", "cypress.config.js"),
    path.join(cwd, "cypress.config.js"),
  ];
  return candidates.find((p) => fs.existsSync(p)) ?? candidates[candidates.length - 1];
}

export const cypressJSRunner: TestRunner = {
  id: "cypress-js",
  async run(cwd, env, onLine) {
    const npx = process.platform.startsWith("win") ? "npx.cmd" : "npx";
    const configPath = findConfig(cwd);
    const reportPath = path.join(cwd, "testmind-generated", "cypress-js", "report.json");

    const args = [
      "cypress",
      "run",
      "--config-file",
      configPath,
      "--reporter",
      "json",
      "--reporter-options",
      `output=${reportPath}`,
    ];

    const proc = execa(npx, args, {
      cwd,
      env,
      reject: false,
    });

    proc.stdout?.on("data", (d) => onLine(d.toString()));
    proc.stderr?.on("data", (d) => onLine(d.toString()));

    const { exitCode } = await proc;
    return exitCode ?? 1;
  },
};
