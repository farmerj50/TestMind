// apps/api/src/testmind/adapters/appium-js/runner.ts
import path from "node:path";
import fs from "node:fs";
import { execa } from "execa";
import type { TestRunner } from "../../core/adapter";

function findSpecsRoot(cwd: string) {
  const candidates = [
    path.join(cwd, "testmind-generated", "appium-js"),
    path.join(cwd, "appium-js"),
  ];
  return candidates.find((p) => fs.existsSync(p)) ?? candidates[candidates.length - 1];
}

export const appiumJSRunner: TestRunner = {
  id: "appium-js",
  async run(cwd, env, onLine) {
    const specsRoot = findSpecsRoot(cwd);
    const npx = process.platform.startsWith("win") ? "npx.cmd" : "npx";
    const reportPath = path.join(specsRoot, "report.json");

    const args = [
      "mocha",
      path.join(specsRoot, "**", "*.spec.js"),
      "--reporter",
      "json",
      "--reporter-options",
      `output=${reportPath}`,
      "--timeout",
      "600000",
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
