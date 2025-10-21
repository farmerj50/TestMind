import fs from "fs/promises";
import path from "path";
import os from "os";
import { randomUUID } from "crypto";

export async function makeWorkdir(): Promise<string> {
  const p = path.join(os.tmpdir(), `tm-run-${randomUUID()}`);
  await fs.mkdir(p, { recursive: true });
  return p;
}

export async function rmrf(p: string) {
  try { await fs.rm(p, { recursive: true, force: true }); } catch {}
}
