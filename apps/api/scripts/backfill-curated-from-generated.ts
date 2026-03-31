import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const REPO_ROOT = path.resolve(process.cwd(), "..", "..");
const API_CURATED_ROOT = path.resolve(REPO_ROOT, "apps", "api", "testmind-curated");

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (name: string) => {
    const idx = args.findIndex((a) => a === name);
    if (idx < 0) return "";
    return args[idx + 1] ?? "";
  };
  const target = get("--target");
  const adapter = get("--adapter") || "playwright-ts";
  const dryRun = args.includes("--dry-run");
  return { target, adapter, dryRun };
}

async function listSpecFiles(root: string): Promise<string[]> {
  if (!fs.existsSync(root)) return [];
  const out: string[] = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop() as string;
    const entries = await fsp.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && /\.(spec|test)\.(t|j)sx?$/i.test(entry.name)) out.push(full);
    }
  }
  return out;
}

async function main() {
  const { target, adapter, dryRun } = parseArgs();
  if (!target) {
    console.error("Usage: pnpm --filter api exec tsx scripts/backfill-curated-from-generated.ts --target <user_id> [--adapter playwright-ts] [--dry-run]");
    process.exit(1);
  }

  const projects = await prisma.project.findMany({
    where: { ownerId: target },
    select: { id: true, name: true },
  });
  const projectSet = new Set(projects.map((p) => p.id));
  const suites = await prisma.curatedSuite.findMany({
    where: { projectId: { in: Array.from(projectSet) } },
    select: { id: true, name: true, projectId: true, rootRel: true },
  });

  const generatedRoots = [
    path.resolve(REPO_ROOT, "testmind-generated", `${adapter}-${target}`),
    path.resolve(REPO_ROOT, "apps", "web", "testmind-generated", `${adapter}-${target}`),
    path.resolve(REPO_ROOT, "apps", "api", "testmind-generated", `${adapter}-${target}`),
  ];

  const report: Array<{
    suiteId: string;
    suiteName: string;
    projectId: string;
    curatedRoot: string;
    beforeSpecs: number;
    sourceUsed: string | null;
    copiedSpecs: number;
  }> = [];

  for (const suite of suites) {
    const curatedRoot = path.resolve(API_CURATED_ROOT, suite.rootRel);
    const before = await listSpecFiles(curatedRoot);
    if (before.length > 0) {
      report.push({
        suiteId: suite.id,
        suiteName: suite.name,
        projectId: suite.projectId,
        curatedRoot,
        beforeSpecs: before.length,
        sourceUsed: null,
        copiedSpecs: 0,
      });
      continue;
    }

    let sourceDir: string | null = null;
    for (const root of generatedRoots) {
      const candidate = path.join(root, suite.projectId);
      const files = await listSpecFiles(candidate);
      if (files.length > 0) {
        sourceDir = candidate;
        break;
      }
    }

    let copiedSpecs = 0;
    if (sourceDir) {
      const files = await listSpecFiles(sourceDir);
      copiedSpecs = files.length;
      if (!dryRun) {
        await fsp.mkdir(curatedRoot, { recursive: true });
        await fsp.cp(sourceDir, curatedRoot, { recursive: true });
      }
    }

    report.push({
      suiteId: suite.id,
      suiteName: suite.name,
      projectId: suite.projectId,
      curatedRoot,
      beforeSpecs: before.length,
      sourceUsed: sourceDir,
      copiedSpecs,
    });
  }

  console.log(
    JSON.stringify(
      {
        mode: dryRun ? "dry-run" : "apply",
        targetUserId: target,
        adapter,
        suites: report,
        updatedSuites: report.filter((r) => r.copiedSpecs > 0).length,
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

