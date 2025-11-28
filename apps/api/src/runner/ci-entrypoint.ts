// apps/api/src/runner/ci-entrypoint.ts
// Minimal CI/CLI entrypoint to enqueue a TestMind run without the HTTP server.
import "dotenv/config";
import { enqueueRun } from "./queue";
import { prisma } from "../prisma";

type ArgMap = Record<string, string>;

function parseArgs(): ArgMap {
  const args: ArgMap = {};
  for (const raw of process.argv.slice(2)) {
    const [k, v] = raw.split("=");
    if (k && v !== undefined) args[k.replace(/^--?/, "")] = v;
  }
  return args;
}

function parseBool(val: string | undefined, fallback: boolean) {
  if (val === undefined) return fallback;
  const n = val.toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(n)) return true;
  if (["0", "false", "no", "n", "off"].includes(n)) return false;
  throw new Error(`Invalid boolean: ${val}`);
}

async function main() {
  const args = parseArgs();
  const projectId =
    args.project ||
    args.projectId ||
    process.env.TM_PROJECT_ID ||
    process.env.PROJECT_ID ||
    "";
  if (!projectId) {
    console.error("projectId is required (arg: --projectId= or env: TM_PROJECT_ID/PROJECT_ID)");
    process.exit(1);
  }

  const projectExists = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, repoUrl: true },
  });
  if (!projectExists?.id) {
    console.error(`Project ${projectId} not found. Provide a valid projectId.`);
    process.exit(1);
  }
  if (!projectExists.repoUrl) {
    console.error(`Project ${projectId} is missing repoUrl. Set repoUrl before triggering a run.`);
    process.exit(1);
  }

  const headful = parseBool(args.headful ?? process.env.HEADFUL, false);
  const grep = args.grep || process.env.TM_GREP || undefined;
  const file = args.file || process.env.TM_FILE || undefined;

  // create run entry similar to /runner/run
  const run = await prisma.testRun.create({
    data: {
      projectId,
      status: "running",
      startedAt: new Date(),
      trigger: "ci",
      paramsJson: { headful, grep, file },
    },
  });

  await enqueueRun(run.id, {
    projectId,
    headed: headful,
    grep,
    // NOTE: runner supports file selection via extraGlobs; preserve here for downstream
    // even if current worker ignores it.
    tags: file ? { include: [file] } : undefined,
  });

  console.log(
    JSON.stringify(
      { runId: run.id, projectId, headful, grep: grep ?? null, file: file ?? null },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});
