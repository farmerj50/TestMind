import path from "node:path";
import fs from "node:fs/promises";
import fsSync from "node:fs";

const cwd = process.cwd();
const repoRoot = fsSync.existsSync(path.join(cwd, "pnpm-workspace.yaml"))
  ? cwd
  : path.resolve(cwd, "..", "..");

export const GENERATED_ROOT =
  process.env.TM_GENERATED_ROOT ?? path.resolve(repoRoot, "testmind-generated");

export const CURATED_ROOT =
  process.env.TM_CURATED_ROOT ?? path.resolve(repoRoot, "testmind-curated");

export const REPORT_ROOT =
  process.env.TM_REPORT_ROOT ?? path.resolve(repoRoot, "testmind-reports");

export async function ensureStorageDirs() {
  await fs.mkdir(GENERATED_ROOT, { recursive: true });
  await fs.mkdir(CURATED_ROOT, { recursive: true });
  await fs.mkdir(REPORT_ROOT, { recursive: true });
}
