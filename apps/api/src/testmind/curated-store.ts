import fs from "fs";
import path from "path";

export const CURATED_ROOT = process.env.TM_CURATED_ROOT
  ? path.resolve(process.env.TM_CURATED_ROOT)
  : path.resolve(process.cwd(), "testmind-curated");
const LEGACY_CURATED_ROOT = path.resolve(process.cwd(), "testmind-curated");
const MIGRATION_MARKER = ".migrated-from-legacy";

const CURATED_MANIFEST = path.join(CURATED_ROOT, "projects.json");

export type CuratedProject = {
  id: string;
  name?: string;
  root?: string;
  locked?: string[];
};

export type CuratedManifest = {
  projects: CuratedProject[];
};

function ensureManifestFile(): CuratedManifest {
  maybeMigrateLegacyCuratedRoot();
  if (!fs.existsSync(CURATED_ROOT)) {
    fs.mkdirSync(CURATED_ROOT, { recursive: true });
  }
  if (!fs.existsSync(CURATED_MANIFEST)) {
    const empty: CuratedManifest = { projects: [] };
    fs.writeFileSync(CURATED_MANIFEST, JSON.stringify(empty, null, 2), "utf8");
    return empty;
  }
  const raw = fs.readFileSync(CURATED_MANIFEST, "utf8");
  try {
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.projects)) {
      return normalizeManifest(parsed);
    }
  } catch {
    // ignore; fallthrough to default
  }
  return { projects: [] };
}

function maybeMigrateLegacyCuratedRoot() {
  if (!process.env.TM_CURATED_ROOT) return;
  if (path.resolve(CURATED_ROOT) === LEGACY_CURATED_ROOT) return;
  if (!fs.existsSync(LEGACY_CURATED_ROOT)) return;

  if (!fs.existsSync(CURATED_ROOT)) {
    fs.mkdirSync(CURATED_ROOT, { recursive: true });
  }

  const markerPath = path.join(CURATED_ROOT, MIGRATION_MARKER);
  if (fs.existsSync(markerPath)) return;

  const entries = fs.readdirSync(CURATED_ROOT);
  const meaningful = entries.filter(
    (name) => name !== "projects.json" && name !== MIGRATION_MARKER
  );
  if (meaningful.length > 0) return;

  try {
    fs.cpSync(LEGACY_CURATED_ROOT, CURATED_ROOT, { recursive: true });
    fs.writeFileSync(
      markerPath,
      `migrated from ${LEGACY_CURATED_ROOT} at ${new Date().toISOString()}\n`,
      "utf8"
    );
    console.warn(
      `[curated] migrated suites from ${LEGACY_CURATED_ROOT} to ${CURATED_ROOT}`
    );
  } catch (err) {
    console.warn("[curated] legacy migration failed", err);
  }
}

function normalizeManifest(manifest: CuratedManifest): CuratedManifest {
  return {
    projects: manifest.projects.map((proj) => ({
      ...proj,
      locked: Array.isArray(proj.locked) ? proj.locked : [],
    })),
  };
}

export function readCuratedManifest(): CuratedManifest {
  return ensureManifestFile();
}

export function writeCuratedManifest(manifest: CuratedManifest) {
  if (!fs.existsSync(CURATED_ROOT)) {
    fs.mkdirSync(CURATED_ROOT, { recursive: true });
  }
  fs.writeFileSync(CURATED_MANIFEST, JSON.stringify(manifest, null, 2), "utf8");
}

export function getCuratedProject(projectId: string) {
  return readCuratedManifest().projects.find((p) => p.id === projectId);
}

export function slugify(value: string) {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "suite"
  );
}

export function ensureWithin(rootDir: string, candidate: string) {
  const rel = path.relative(rootDir, candidate);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("Path escapes project root");
  }
}

export function ensureCuratedProjectEntry(id: string, name?: string) {
  const manifest = readCuratedManifest();
  let project = manifest.projects.find((p) => p.id === id);
  if (!project) {
    const rel = id;
    project = { id, name: name ?? id, root: rel, locked: [] };
    manifest.projects.push(project);
    writeCuratedManifest(manifest);
  } else if (name && project.name !== name) {
    project.name = name;
    writeCuratedManifest(manifest);
  }
  const root = path.resolve(CURATED_ROOT, project.root ?? project.id);
  fs.mkdirSync(root, { recursive: true });
  return { project, root };
}

export function deleteCuratedProject(projectId: string) {
  const manifest = readCuratedManifest();
  const idx = manifest.projects.findIndex((p) => p.id === projectId);
  if (idx === -1) return false;
  const [removed] = manifest.projects.splice(idx, 1);
  writeCuratedManifest(manifest);
  const root = path.resolve(CURATED_ROOT, removed.root ?? removed.id);
  fs.rmSync(root, { recursive: true, force: true });
  return true;
}

export const agentSuiteId = (projectId: string) => `agent-${projectId}`;
