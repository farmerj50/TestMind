import fs from "fs";
import path from "path";
import { GENERATED_ROOT } from "../lib/storageRoots.js";

// Extracted verbatim from testmind/routes.ts's GET /generated/list handler so other
// server-side code (Dev Agent Mode's code-phase prompt) can list a project's existing
// generated specs without duplicating the directory-resolution/walk logic.
export function adapterDir(adapterId: string, userId: string): string {
  return path.join(GENERATED_ROOT, `${adapterId}-${userId}`);
}

export function adapterProjectDir(adapterId: string, userId: string, projectId?: string): string {
  return projectId ? path.join(adapterDir(adapterId, userId), projectId) : adapterDir(adapterId, userId);
}

export function listGeneratedSpecFiles(
  adapterId: string,
  userId: string,
  projectId?: string
): { path: string; size: number }[] {
  let root = adapterProjectDir(adapterId, userId, projectId);
  if (projectId && !fs.existsSync(root)) {
    const fallback = adapterDir(adapterId, userId);
    if (fs.existsSync(fallback)) root = fallback;
  }
  if (!fs.existsSync(root)) return [];

  const list: { path: string; size: number }[] = [];
  const walk = (dir: string, rel = "") => {
    for (const name of fs.readdirSync(dir)) {
      const abs = path.join(dir, name);
      const r = path.join(rel, name);
      const st = fs.statSync(abs);
      if (st.isDirectory()) walk(abs, r);
      else list.push({ path: r.replace(/\\/g, "/"), size: st.size });
    }
  };
  walk(root);
  return list;
}
