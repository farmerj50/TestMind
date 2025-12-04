import fs from "fs/promises";
import path from "path";
import os from "os";

export async function makeWorkdir(runId?: string): Promise<{ repoRoot: string; workdir: string; outDir: string }> {
  // Local reuse path: use TM_LOCAL_REPO_ROOT if provided
  const localRoot = process.env.TM_LOCAL_REPO_ROOT;
  if (localRoot) {
    const repoRoot = path.resolve(localRoot);
    const workdir = path.join(repoRoot, "apps", "web");
    const outDir = path.join(repoRoot, "apps", "api", "runner-logs", runId || "local-run");
    await fs.mkdir(outDir, { recursive: true });
    return { repoRoot, workdir, outDir };
  }

  // Fallback: temp workdir (legacy behavior)
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tm-run-"));
  return { repoRoot: dir, workdir: dir, outDir: path.join(dir, "runner-logs", runId || "temp-run") };
}

export async function rmrf(p: string) {
  try { await fs.rm(p, { recursive: true, force: true }); } catch {}
}

