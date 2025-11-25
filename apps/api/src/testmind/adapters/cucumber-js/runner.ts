// apps/api/src/testmind/adapters/cucumber-js/runner.ts
import path from "node:path";
import fs from "node:fs";
import { execa } from "execa";
import type { TestRunner } from "../../core/adapter.js";

function findFeaturesRoot(cwd: string) {
  const candidates = [
    path.join(cwd, "testmind-generated", "cucumber-js", "features"),
    path.join(cwd, "testmind-generated", "cucumber", "features"),
    path.join(cwd, "features"),
  ];
  return candidates.find((p) => fs.existsSync(p)) ?? candidates[candidates.length - 1];
}

export const cucumberJSRunner: TestRunner = {
  id: "cucumber-js",
  async run(cwd, env, onLine) {
    const featuresRoot = findFeaturesRoot(cwd);
    const npx = process.platform.startsWith("win") ? "npx.cmd" : "npx";
    const reportPath = path.join(path.dirname(featuresRoot), "report.json");

    const args = [
      "cucumber-js",
      featuresRoot,
      "--require",
      path.join(path.dirname(featuresRoot), "steps", "**", "*.js"),
      "--require",
      path.join(path.dirname(featuresRoot), "support", "**", "*.js"),
      "--publish-quiet",
      "--format",
      `json:${reportPath}`,
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
