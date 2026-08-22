// Centralized resolution for where a project's generated Playwright/etc. spec files live on
// disk. Historically this logic was reimplemented independently in ~24 places across the API
// (runner/worker.ts, routes/run.ts, testmind/routes.ts, routes/tests.ts, ...), and about a third
// of those implementations silently fell back to a directory shared across ALL of a user's
// projects when a project-scoped directory didn't exist yet — which is exactly how one
// project's "Generate tests" run could overwrite/leak into another project's specs.
//
// This module makes that bug class structurally hard to reintroduce: `projectId` is a
// required field, not an optional fallback path, and `resolveGeneratedSpecDir` NEVER returns a
// directory that isn't scoped to the exact project requested — it returns `null` instead.
//
// Adapted from the one existing implementation that already got this right:
// apps/api/src/testmind/routes.ts's `resolveGeneratedSource`/`adapterProjectDir`/
// `mirrorGeneratedToWeb`. This module does not change behavior for any existing caller yet —
// nothing calls it until each call site is migrated individually (see the project plan).
import path from "node:path";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { GENERATED_ROOT } from "./storageRoots.js";

export interface GeneratedSpecScope {
  adapterId: string;
  userId: string;
  /** Required — the whole point of this module is that this can't be omitted. */
  projectId: string;
}

function scopeFolder(scope: GeneratedSpecScope): string {
  return `${scope.adapterId}-${scope.userId}`;
}

/**
 * Pure path construction for a project's generated-spec directory under `root`
 * (defaults to the canonical GENERATED_ROOT). Does not check existence and is safe
 * to use for both read and write call sites.
 */
export function generatedSpecDir(scope: GeneratedSpecScope, root: string = GENERATED_ROOT): string {
  return path.join(root, scopeFolder(scope), scope.projectId);
}

/**
 * The ordered list of directories that would be searched for this project's specs —
 * `GENERATED_ROOT` first, then any `additionalRoots` in the order given. Exposed so callers
 * that need to build a diagnostic/error message (e.g. "tried: ...") don't have to reimplement
 * root discovery themselves.
 */
export function generatedSpecCandidateRoots(
  scope: GeneratedSpecScope,
  additionalRoots: string[] = []
): string[] {
  const roots = [GENERATED_ROOT, ...additionalRoots];
  return roots.map((root) => generatedSpecDir(scope, root));
}

/**
 * Search known roots for this EXACT project's generated-spec directory. Unlike the historical
 * scattered implementations, this NEVER falls back to a directory not scoped to `projectId` —
 * it returns `null` instead, so callers can decide what "not found" means for them (e.g. "run
 * generation first" vs. "create it now").
 */
export function resolveGeneratedSpecDir(
  scope: GeneratedSpecScope,
  opts?: { additionalRoots?: string[] }
): string | null {
  const candidates = generatedSpecCandidateRoots(scope, opts?.additionalRoots ?? []);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Ensures the project-scoped directory exists (creating it if needed) and returns its path.
 * Use at generation-write time, not for reads.
 */
export async function ensureGeneratedSpecDir(
  scope: GeneratedSpecScope,
  root: string = GENERATED_ROOT
): Promise<string> {
  const dir = generatedSpecDir(scope, root);
  await fsPromises.mkdir(dir, { recursive: true });
  return dir;
}

/**
 * Mirrors a generated-spec directory into a (possibly cloned) repo's own
 * apps/web/testmind-generated tree, scoped to this exact project. Adapted from
 * `mirrorGeneratedToWeb` in testmind/routes.ts — deliberately does not carry over that
 * function's legacy no-projectId branch, since an unscoped mirror is the original bug.
 */
export async function mirrorGeneratedSpecDir(
  scope: GeneratedSpecScope,
  repoPath: string,
  sourceDir: string
): Promise<void> {
  const webRoot = path.resolve(repoPath, "apps", "web", "testmind-generated");
  const dest = path.join(webRoot, scopeFolder(scope), scope.projectId);
  const sourceResolved = path.resolve(sourceDir);
  const destResolved = path.resolve(dest);
  if (sourceResolved.startsWith(webRoot)) return;
  await fsPromises.rm(destResolved, { recursive: true, force: true }).catch(() => {});
  await fsPromises.mkdir(path.dirname(destResolved), { recursive: true });
  await fsPromises.cp(sourceResolved, destResolved, { recursive: true });
}
