import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const REPO_ROOT = path.resolve(process.cwd(), "..", "..");

const ADAPTERS = ["playwright-ts", "cucumber-js", "cypress-js", "appium-js", "xctest"] as const;
const ROOTS = ["testmind-generated", "apps/web/testmind-generated", "apps/api/testmind-generated"] as const;

type MoveStat = {
  root: string;
  adapter: string;
  source: string;
  target: string;
  copiedProjects: number;
  copiedFiles: number;
};

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (name: string) => {
    const idx = args.findIndex((a) => a === name);
    if (idx < 0) return "";
    return args[idx + 1] ?? "";
  };
  const target = get("--target");
  const sourcesRaw = get("--sources");
  const dryRun = args.includes("--dry-run");
  const sources = sourcesRaw
    .split(/[,\s]+/)
    .map((v) => v.trim())
    .filter(Boolean);
  return { target, sources, dryRun };
}

async function fileCount(dir: string): Promise<number> {
  let count = 0;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop() as string;
    const entries = await fsp.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) count += 1;
    }
  }
  return count;
}

async function copyIfMissing(src: string, dest: string, dryRun: boolean) {
  if (!fs.existsSync(src)) return { copied: false, files: 0 };
  if (fs.existsSync(dest)) return { copied: false, files: 0 };
  const files = await fileCount(src);
  if (!dryRun) {
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.cp(src, dest, { recursive: true });
  }
  return { copied: true, files };
}

async function main() {
  const { target, sources, dryRun } = parseArgs();
  if (!target || !sources.length) {
    console.error(
      "Usage: pnpm --filter api exec tsx scripts/migrate-generated-assets.ts --target <user_id> --sources <id1,id2,...> [--dry-run]"
    );
    process.exit(1);
  }
  if (sources.includes(target)) {
    console.error("Target user ID must not be included in --sources.");
    process.exit(1);
  }

  const projectIds = (
    await prisma.project.findMany({
      where: { ownerId: target },
      select: { id: true },
    })
  ).map((p) => p.id);

  const stats: MoveStat[] = [];

  for (const relRoot of ROOTS) {
    const root = path.resolve(REPO_ROOT, relRoot);
    if (!fs.existsSync(root)) continue;

    for (const adapter of ADAPTERS) {
      const targetBase = path.join(root, `${adapter}-${target}`);
      let copiedProjects = 0;
      let copiedFiles = 0;

      for (const source of sources) {
        const sourceBase = path.join(root, `${adapter}-${source}`);
        if (!fs.existsSync(sourceBase)) continue;
        for (const projectId of projectIds) {
          const sourceProjectDir = path.join(sourceBase, projectId);
          const targetProjectDir = path.join(targetBase, projectId);
          const res = await copyIfMissing(sourceProjectDir, targetProjectDir, dryRun);
          if (res.copied) {
            copiedProjects += 1;
            copiedFiles += res.files;
          }
        }
      }

      stats.push({
        root,
        adapter,
        source: sources.join(","),
        target,
        copiedProjects,
        copiedFiles,
      });
    }
  }

  console.log(
    JSON.stringify(
      {
        mode: dryRun ? "dry-run" : "apply",
        targetUserId: target,
        sources,
        projectIds,
        stats: stats.filter((s) => s.copiedProjects > 0),
      },
      null,
      2
    )
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
