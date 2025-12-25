import path from "node:path";
import fs from "node:fs/promises";
import fsSync from "node:fs";

const cwd = process.cwd();
const repoRoot = fsSync.existsSync(path.join(cwd, "pnpm-workspace.yaml"))
  ? cwd
  : path.resolve(cwd, "..", "..");

const dataRoot = fsSync.existsSync("/data") ? "/data" : null;

const defaultRoot = (envKey: string, fallbackName: string) =>
  process.env[envKey] ??
  (dataRoot ? path.join(dataRoot, fallbackName) : path.resolve(repoRoot, fallbackName));

export const GENERATED_ROOT = defaultRoot("TM_GENERATED_ROOT", "testmind-generated");

export const CURATED_ROOT = defaultRoot("TM_CURATED_ROOT", "testmind-curated");

export const REPORT_ROOT = defaultRoot("TM_REPORT_ROOT", "testmind-reports");

export async function ensureStorageDirs() {
  await fs.mkdir(GENERATED_ROOT, { recursive: true });
  await fs.mkdir(CURATED_ROOT, { recursive: true });
  await fs.mkdir(REPORT_ROOT, { recursive: true });
  await fs.mkdir(path.join(REPORT_ROOT, "runner-logs"), { recursive: true });
}
