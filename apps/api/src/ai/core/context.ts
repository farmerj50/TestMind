import path from "path";
import fs from "fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { prisma } from "../../prisma.js";
import type { SelfHealPayload } from "../../runner/queue.js";
import { CURATED_ROOT } from "../../testmind/curated-store.js";
import { GENERATED_ROOT, REPORT_ROOT } from "../../lib/storageRoots.js";
import { extractTestTitle } from "../../runner/test-title.js";
import { DEFAULT_FRAMEWORK_ID } from "@testmind/core/framework";
import type { AiExecutionContext } from "./types.js";

export const toPosix = (value: string) => value.replace(/\\/g, "/");

export function normalizeGeneratedSpecPath(rawPath: string, adapterId: string = DEFAULT_FRAMEWORK_ID) {
  const normalized = String(rawPath || "").replace(/\\/g, "/").replace(/^\.?\/+/, "").replace(/^\/+/, "");
  if (!normalized) return "unknown-spec";
  if (adapterId !== "cucumber-js") return normalized;
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length >= 3 && ["features", "steps", "support"].includes(parts[1])) {
    return parts.slice(1).join("/");
  }
  return normalized;
}

export function guessRepoRoot() {
  const explicit = process.env.TM_LOCAL_REPO_ROOT;
  if (explicit) return path.resolve(explicit);
  const candidates = [
    path.resolve(process.cwd(), "..", ".."),
    path.resolve(process.cwd(), ".."),
    process.cwd(),
  ];
  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, "apps", "api"))) {
      return candidate;
    }
  }
  return candidates[0];
}

export function buildSpecCandidates(
  repoRoot: string,
  normalizedSpecPath: string,
  rawPath: string,
  adapterId: string = DEFAULT_FRAMEWORK_ID
) {
  const fallback = normalizedSpecPath || "unknown-spec";
  const candidates = new Set<string>();
  const generatedRoots = Array.from(
    new Set([
      path.resolve(GENERATED_ROOT),
      path.join(repoRoot, "apps", "testmind-generated"),
      path.join(repoRoot, "apps", "web", "testmind-generated"),
      path.join(repoRoot, "apps", "api", "testmind-generated"),
    ])
  );

  if (path.isAbsolute(rawPath)) {
    candidates.add(rawPath);
  }
  if (normalizedSpecPath && !normalizedSpecPath.startsWith("apps/")) {
    candidates.add(path.join(repoRoot, "apps", "web", normalizedSpecPath));
    candidates.add(path.join(repoRoot, "apps", "api", normalizedSpecPath));
  }
  if (normalizedSpecPath) {
    candidates.add(path.join(repoRoot, normalizedSpecPath));
  }

  for (const generatedRoot of generatedRoots) {
    if (normalizedSpecPath) {
      const strippedGenerated = normalizedSpecPath.replace(/^testmind-generated[\\/]/, "");
      candidates.add(path.join(generatedRoot, strippedGenerated));
    }
    candidates.add(path.join(generatedRoot, path.basename(fallback)));
    candidates.add(path.join(generatedRoot, adapterId, path.basename(fallback)));
  }

  if (adapterId === "cucumber-js" && normalizedSpecPath) {
    const rawNormalized = String(rawPath || "").replace(/\\/g, "/").replace(/^\.?\/+/, "").replace(/^\/+/, "");
    const featureRelative = normalizeGeneratedSpecPath(rawNormalized, adapterId);
    const rawParts = rawNormalized.split("/").filter(Boolean);
    const projectId =
      rawParts.length >= 3 && ["features", "steps", "support"].includes(rawParts[1]) ? rawParts[0] : null;

    for (const generatedRoot of generatedRoots) {
      candidates.add(path.join(generatedRoot, featureRelative));
      if (projectId) {
        candidates.add(path.join(generatedRoot, projectId, featureRelative));
      }
      try {
        for (const entry of readdirSync(generatedRoot, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const childRoot = path.join(generatedRoot, entry.name);
          candidates.add(path.join(childRoot, featureRelative));
          if (projectId) {
            candidates.add(path.join(childRoot, projectId, featureRelative));
          }
        }
      } catch {
        // ignore unreadable generated roots
      }
    }
  }

  if (process.env.TM_LOCAL_SPECS) {
    const localSpecsRoot = path.resolve(process.env.TM_LOCAL_SPECS);
    if (normalizedSpecPath) {
      candidates.add(path.join(localSpecsRoot, normalizedSpecPath));
    }
    candidates.add(path.join(localSpecsRoot, path.basename(fallback)));
  }

  return Array.from(candidates);
}

export async function findExistingPath(paths: string[]): Promise<string | null> {
  for (const candidate of paths) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // ignore missing paths
    }
  }
  return null;
}

export async function buildAiExecutionContext(job: SelfHealPayload): Promise<AiExecutionContext> {
  const logRoots = [
    REPORT_ROOT,
    path.join(process.cwd(), "runner-logs"),
    path.join(process.cwd(), "apps", "api", "runner-logs"),
  ];
  const runLogDir =
    logRoots.find((root) => existsSync(path.join(root, job.runId))) ??
    path.join(REPORT_ROOT, job.runId);
  const stdoutPath = path.join(runLogDir, "stdout.txt");
  const stderrPath = path.join(runLogDir, "stderr.txt");

  const [stdout, stderr, result, fallbackCase] = await Promise.all([
    fs.readFile(stdoutPath, "utf8").catch(() => ""),
    fs.readFile(stderrPath, "utf8").catch(() => ""),
    prisma.testResult.findUnique({
      where: { id: job.testResultId },
      select: { message: true, testCase: { select: { key: true, title: true } } },
    }),
    prisma.testCase.findUnique({
      where: { id: job.testCaseId },
      select: { key: true, title: true },
    }),
  ]);

  const key = result?.testCase?.key ?? fallbackCase?.key ?? "unknown-spec";
  const runSpecPathRaw = key.split("#")[0] || key;
  const runSpecPath = runSpecPathRaw.replace(/\\/g, "/");
  const effectiveAdapterId = job.adapterId || DEFAULT_FRAMEWORK_ID;
  const normalizedSpecPath = normalizeGeneratedSpecPath(runSpecPath, effectiveAdapterId);
  const repoRoot = guessRepoRoot();

  let preferredAbsolutePath: string | null = null;
  if (runSpecPath.includes("__agent/agent-")) {
    const match = runSpecPath.match(/__agent\/(agent-[^/]+)(\/.*)?$/);
    if (match) {
      const suiteId = match[1];
      const remainder = match[2]?.replace(/^\/+/, "") ?? "";
      const candidate = path.join(CURATED_ROOT, suiteId, remainder);
      if (existsSync(candidate)) {
        preferredAbsolutePath = candidate;
      }
    }
  }

  if (!preferredAbsolutePath) {
    const candidates = buildSpecCandidates(repoRoot, normalizedSpecPath, runSpecPathRaw, effectiveAdapterId);
    preferredAbsolutePath = await findExistingPath(candidates);
  }

  const repoAbsolutePath = preferredAbsolutePath ?? path.join(repoRoot, normalizedSpecPath);
  const repoRelativePath = preferredAbsolutePath
    ? toPosix(path.relative(repoRoot, preferredAbsolutePath))
    : toPosix(normalizedSpecPath);

  const repoSpecContent = await fs.readFile(repoAbsolutePath, "utf8").catch(() => undefined);
  const runSpecContent = await fs.readFile(runSpecPathRaw, "utf8").catch(() => undefined);
  const rawTitle = result?.testCase?.title ?? fallbackCase?.title ?? job.testTitle ?? null;

  return {
    mode: "autonomous",
    job,
    scope: {
      projectId: job.projectId,
      runId: job.runId,
      testResultId: job.testResultId,
      testCaseId: job.testCaseId,
      framework: effectiveAdapterId,
      specPath: repoRelativePath,
    },
    repoRoot,
    repoRelativePath,
    repoAbsolutePath,
    runSpecPath: runSpecContent ? runSpecPathRaw : undefined,
    specContent: repoSpecContent ?? runSpecContent,
    failure: {
      stdout,
      stderr,
      message: result?.message,
      testTitle: extractTestTitle(rawTitle),
    },
  };
}
