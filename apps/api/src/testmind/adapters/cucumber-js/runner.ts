import path from "node:path";
import fs from "node:fs";
import { promises as fsp } from "node:fs";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import type { TestRunner } from "../../core/adapter.js";

function unique(paths: Array<string | null | undefined>) {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of paths) {
    if (!value) continue;
    const normalized = path.resolve(value);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function findProjectRoot(cwd: string, env: Record<string, string>) {
  const configuredFeatures = env.TM_CUCUMBER_FEATURES_ROOT?.trim()
    ? path.resolve(env.TM_CUCUMBER_FEATURES_ROOT.trim())
    : null;

  const candidates = unique([
    configuredFeatures,
    configuredFeatures ? path.dirname(configuredFeatures) : null,
    path.join(cwd, "testmind-generated", "cucumber-js"),
    path.join(cwd, "testmind-generated", "cucumber"),
    path.join(cwd, "apps", "testmind-generated", "cucumber-js"),
    path.join(cwd, "apps", "testmind-generated", "cucumber"),
    cwd,
  ]);

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    const stats = fs.statSync(candidate);
    if (!stats.isDirectory()) continue;

    if (path.basename(candidate).toLowerCase() === "features") {
      return path.dirname(candidate);
    }

    if (fs.existsSync(path.join(candidate, "features"))) {
      return candidate;
    }

    const nested = fs
      .readdirSync(candidate, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(candidate, entry.name))
      .find((dir) => fs.existsSync(path.join(dir, "features")));

    if (nested) {
      return nested;
    }
  }

  return configuredFeatures ? path.dirname(configuredFeatures) : cwd;
}

function normalizeSelectedFile(projectRoot: string, value: string) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "";
  if (path.isAbsolute(trimmed)) return trimmed;

  const normalized = trimmed.replace(/\\/g, "/").replace(/^\/+/, "");
  const projectId = path.basename(projectRoot).replace(/\\/g, "/");
  const knownRoots = ["features/", "steps/", "support/"];

  for (const root of knownRoots) {
    const idx = normalized.indexOf(root);
    if (idx >= 0) {
      return path.resolve(projectRoot, normalized.slice(idx));
    }
  }

  if (projectId && normalized.startsWith(`${projectId}/`)) {
    return path.resolve(projectRoot, normalized.slice(projectId.length + 1));
  }

  return path.resolve(projectRoot, normalized);
}

function readSelectedFiles(projectRoot: string, env: Record<string, string>) {
  const raw = env.TM_CUCUMBER_FILES?.trim();
  if (!raw) return [] as string[];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((value) => normalizeSelectedFile(projectRoot, String(value || "")))
      .filter(Boolean);
  } catch {
    return [];
  }
}

const runtimeSupportPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "runtime-support.cjs"
);

export const cucumberJSRunner: TestRunner = {
  id: "cucumber-js",
  async run(cwd, env, onLine) {
    const projectRoot = findProjectRoot(cwd, env);
    const featuresRoot = path.join(projectRoot, "features");
    const stepsGlob = path.join(projectRoot, "steps", "**", "*.{js,ts,mjs,cjs}");
    const supportGlob = path.join(projectRoot, "support", "**", "*.{js,ts,mjs,cjs}");
    const npx = process.platform.startsWith("win") ? "npx.cmd" : "npx";
    const reportPath = env.TM_CUCUMBER_REPORT_PATH
      ? path.resolve(env.TM_CUCUMBER_REPORT_PATH)
      : path.join(projectRoot, "report.json");
    await fsp.mkdir(path.dirname(reportPath), { recursive: true }).catch(() => {});
    const reportArgPath = path.relative(cwd, reportPath) || path.basename(reportPath);
    const selectedFiles = readSelectedFiles(projectRoot, env);

    onLine(`[cucumber] projectRoot=${projectRoot}\n`);
    onLine(`[cucumber] featuresRoot=${featuresRoot}\n`);
    onLine(`[cucumber] runtimeSupport=${runtimeSupportPath}\n`);
    onLine(`[cucumber] selectedFiles=${JSON.stringify(selectedFiles)}\n`);

    const args = [
      "cucumber-js",
      ...(selectedFiles.length ? selectedFiles : [featuresRoot]),
      "--require",
      runtimeSupportPath,
      "--require",
      stepsGlob,
      "--require",
      supportGlob,
      "--format",
      `json:${reportArgPath.replace(/\\/g, "/")}`,
    ];

    const namePattern = env.TM_CUCUMBER_GREP?.trim();
    if (namePattern) {
      args.push("--name", namePattern);
    }

    const proc = execa(npx, args, {
      cwd,
      env: { ...env, CUCUMBER_PUBLISH_ENABLED: "false" },
      reject: false,
    });

    proc.stdout?.on("data", (d) => onLine(d.toString()));
    proc.stderr?.on("data", (d) => onLine(d.toString()));

    const { exitCode } = await proc;
    return exitCode ?? 1;
  },
};
