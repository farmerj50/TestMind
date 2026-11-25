import fs from "node:fs";
import path from "node:path";
import { redactText } from "../security/redaction.js";

const OMIT = new Set(["node_modules", "dist", "build", "coverage", "vendor"]);
/** Bounded source and test context from an authorized checkout; never follow links or read secrets. */
export function repositoryEvidence(root: string, objective: string): Array<{ path: string; content: string }> {
  const terms: string[] = objective.toLowerCase().match(/[a-z][a-z0-9_-]{3,}/g) ?? [];
  const candidates: Array<{ path: string; content: string; score: number }> = [];
  const dirs = [root];
  let visited = 0;
  while (dirs.length && visited < 1500) {
    const dir = dirs.pop()!;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (++visited > 1500) break;
      if (entry.name.startsWith(".") || entry.isSymbolicLink() || OMIT.has(entry.name)) continue;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) { dirs.push(absolute); continue; }
      if (!entry.isFile() || !/\.[cm]?[jt]sx?$/.test(entry.name) || /(?:secrets?|credentials?|private[-_]?key)/i.test(entry.name)) continue;
      if (fs.statSync(absolute).size > 128 * 1024) continue;
      const relative = path.relative(root, absolute).replace(/\\/g, "/");
      const source = fs.readFileSync(absolute, "utf8");
      const lower = `${relative}\n${source}`.toLowerCase();
      const score = terms.reduce((n, term) => n + (relative.toLowerCase().includes(term) ? 8 : lower.includes(term) ? 1 : 0), 0);
      candidates.push({ path: relative, content: redactText(source.slice(0, 5000)), score });
    }
  }
  candidates.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  const tests = candidates.filter((f) => /\.(test|spec)\./.test(f.path)).slice(0, 5);
  const sources = candidates.filter((f) => !/\.(test|spec)\./.test(f.path)).slice(0, 7);
  return [...sources, ...tests].map(({ path, content }) => ({ path, content }));
}
