import fs from "fs/promises";
import path from "path";
import os from "os";

// Return a workdir path. If TM_LOCAL_REPO_ROOT is set, reuse that (user-managed).
export async function makeWorkdir(): Promise<string> {
  const localRoot = process.env.TM_LOCAL_REPO_ROOT;
  if (localRoot) {
    return path.resolve(localRoot);
  }
  return await fs.mkdtemp(path.join(os.tmpdir(), "tm-run-"));
}

export async function rmrf(p: string) {
  try { await fs.rm(p, { recursive: true, force: true }); } catch {}
}

