import fs from "node:fs";
import path from "node:path";

function isWithinOrEqual(parent: string, child: string) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Keep an existing mounted-volume target exact instead of remapping it through the repo. */
export function resolveExistingAiTarget(specPath: string, generatedDir?: string) {
  if (!path.isAbsolute(specPath) || !fs.existsSync(specPath)) return null;
  const target = path.resolve(specPath);
  const targetIsDirectory = fs.statSync(target).isDirectory();
  const explicitDir = generatedDir ? path.resolve(generatedDir) : null;
  const testDir = targetIsDirectory
    ? target
    : explicitDir && isWithinOrEqual(explicitDir, target)
      ? explicitDir
      : path.dirname(target);
  return { target, testDir, targetIsDirectory };
}

export function resolveAiGeneratedDir(payloadDir: unknown, persistedDir: unknown) {
  const value = typeof payloadDir === "string" && payloadDir.trim()
    ? payloadDir
    : typeof persistedDir === "string" && persistedDir.trim()
      ? persistedDir
      : undefined;
  return value ? path.resolve(value) : undefined;
}
