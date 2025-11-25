import fs from "fs/promises";
import path from "path";
import os from "os";

export async function makeWorkdir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tm-run-"));
  return dir;
}

export async function rmrf(p: string) {
  try { await fs.rm(p, { recursive: true, force: true }); } catch {}
}

