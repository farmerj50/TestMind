import path from "path";
import fs from "fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { prisma } from "../../prisma.js";
import type { SelfHealPayload } from "../../runner/queue.js";
import { CURATED_ROOT } from "../../testmind/curated-store.js";
import { GENERATED_ROOT, REPORT_ROOT } from "../../lib/storageRoots.js";
import { extractTestTitle } from "../../runner/test-title.js";
import { DEFAULT_FRAMEWORK_ID } from "@testmind/core/framework";
import { classifyFailureContext } from "./repair-policy.js";
import type { AiActionMode, AiEvidenceArtifact, AiExecutionContext } from "./types.js";

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
  adapterId: string = DEFAULT_FRAMEWORK_ID,
  projectId?: string
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

  // Search CURATED_ROOT for curated spec paths, scoped to the current project to prevent
  // cross-project spec bleed. Handles cases where the TestCase key stores a path relative
  // to the suite root (e.g. "www-suite/caseId/spec.ts") but the file lives at
  // CURATED_ROOT/project-id/www-suite/caseId/spec.ts.
  //
  // Also handles container-absolute keys: when Playwright runs in Docker it records
  // paths like /app/testmind-curated/project-X/suite/spec.ts. We strip everything up
  // to and including "testmind-curated/" to get the repo-relative portion.
  const curatedRoots = Array.from(new Set([
    path.resolve(CURATED_ROOT),
    path.join(repoRoot, "apps", "api", "testmind-curated"),
  ]));

  // Strip container-absolute curated prefix from rawPath (e.g. /app/testmind-curated/...)
  const rawPosix = rawPath.replace(/\\/g, "/");
  const curatedPrefixMatch = rawPosix.match(/testmind-curated\/(.+)$/);
  if (curatedPrefixMatch) {
    const curatedRelPath = curatedPrefixMatch[1]; // e.g. project-X/suite-Y/login.spec.ts
    for (const curatedRoot of curatedRoots) {
      candidates.add(path.join(curatedRoot, curatedRelPath));
    }
  }

  if (normalizedSpecPath && projectId) {
    const projectPrefixes = [`project-${projectId}`, `agent-${projectId}`];
    for (const curatedRoot of curatedRoots) {
      for (const prefix of projectPrefixes) {
        const projectDir = path.join(curatedRoot, prefix);
        candidates.add(path.join(projectDir, normalizedSpecPath));
        try {
          for (const d of readdirSync(projectDir, { withFileTypes: true })) {
            if (!d.isDirectory()) continue;
            candidates.add(path.join(projectDir, d.name, normalizedSpecPath));
          }
        } catch { /* ignore unreadable dirs */ }
      }
    }
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

async function readSnippet(filePath: string, limit: number) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return raw.slice(0, limit);
  } catch {
    return "";
  }
}

async function walkFiles(root: string, limit = 80) {
  const out: string[] = [];
  const pending = [root];
  while (pending.length && out.length < limit) {
    const current = pending.shift();
    if (!current) continue;
    let entries: import("node:fs").Dirent[] = [];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (out.length >= limit) break;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(full);
        continue;
      }
      out.push(full);
    }
  }
  return out;
}

function detectArtifactType(filePath: string): AiEvidenceArtifact["type"] {
  const lower = toPosix(filePath).toLowerCase();
  if (lower.endsWith("report.json")) return "report";
  if (lower.endsWith("page-signals.json")) return "page-signals";
  if (lower.endsWith("error-context.md")) return "error-context";
  if (/\.(png|jpg|jpeg|gif|webp)$/i.test(lower)) return "screenshot";
  if (/\.(webm|mp4|mov)$/i.test(lower)) return "video";
  if (/\.(zip)$/i.test(lower) || /trace/i.test(lower)) return "trace";
  if (/\.(json)$/i.test(lower)) return "json";
  if (/\.(log|txt|md)$/i.test(lower)) return "text";
  return "other";
}

async function collectEvidenceArtifacts(runLogDir: string, normalizedSpecPath: string) {
  const allFiles = await walkFiles(runLogDir);
  const specStem = path.basename(normalizedSpecPath, path.extname(normalizedSpecPath)).toLowerCase();
  const prioritized = allFiles.filter((filePath) => {
    const lower = toPosix(filePath).toLowerCase();
    return (
      lower.includes(specStem) ||
      lower.endsWith("report.json") ||
      lower.endsWith("page-signals.json") ||
      lower.endsWith("error-context.md") ||
      lower.includes("trace") ||
      lower.includes("screenshot") ||
      lower.includes("video")
    );
  });
  const chosen = prioritized.slice(0, 12);
  const artifacts = await Promise.all(
    chosen.map(async (filePath): Promise<AiEvidenceArtifact> => {
      const type = detectArtifactType(filePath);
      const excerpt =
        type === "report" ||
        type === "page-signals" ||
        type === "error-context" ||
        type === "json" ||
        type === "text"
          ? await readSnippet(filePath, 1600)
          : null;
      return {
        type,
        path: toPosix(path.relative(runLogDir, filePath)),
        label: path.basename(filePath),
        excerpt: excerpt || null,
      };
    })
  );
  return artifacts;
}

function parsePageSignalsSummary(snippet: string) {
  if (!snippet) return null;
  try {
    const parsed = JSON.parse(snippet);
    const signals = parsed?.signals ?? parsed;
    const dom = signals?.dom ?? {};
    return {
      url: typeof signals?.url === "string" ? signals.url : "",
      title: typeof dom?.title === "string" ? dom.title.trim() : "",
      h1: typeof dom?.h1 === "string" ? dom.h1.trim() : "",
      bodyText: typeof dom?.bodyText === "string" ? dom.bodyText.trim() : "",
    };
  } catch {
    return null;
  }
}

function parseLocatorResolutionFailure(message?: string | null) {
  if (!message || !message.includes("LOCATOR_RESOLUTION_FAILED")) return null;
  const jsonMatch = message.match(/\{[\s\S]*"code"\s*:\s*"LOCATOR_RESOLUTION_FAILED"[\s\S]*\}/);
  if (!jsonMatch) return null;
  try {
    const parsed = JSON.parse(jsonMatch[0]);
    return {
      attemptedSelectors: Array.isArray(parsed?.attemptedSelectors)
        ? parsed.attemptedSelectors.filter((value: unknown) => typeof value === "string").slice(0, 8)
        : [],
      failures: Array.isArray(parsed?.failures)
        ? parsed.failures.filter((value: unknown) => typeof value === "string").slice(0, 6)
        : [],
      selectedSelector:
        typeof parsed?.selectedSelector === "string" ? parsed.selectedSelector : null,
    };
  } catch {
    return null;
  }
}

function parsePathMismatch(message?: string | null) {
  if (!message) return null;
  const match = message.match(/Expected pathname(?: to start with)? ([^\s]+) but saw ([^\s]+)/i);
  if (!match) return null;
  return {
    expectedPath: match[1],
    actualPath: match[2],
  };
}

function buildStructuredEvidenceSummary(input: {
  failureMessage?: string | null;
  pageSignalsSnippet?: string;
  errorContextSnippet?: string;
  artifacts: AiEvidenceArtifact[];
}) {
  const parts: string[] = [];
  const pageSignals = parsePageSignalsSummary(input.pageSignalsSnippet ?? "");
  if (pageSignals) {
    parts.push(
      [
        "Page signals:",
        pageSignals.url ? `url=${pageSignals.url}` : "",
        pageSignals.title ? `title=${pageSignals.title}` : "",
        pageSignals.h1 ? `h1=${pageSignals.h1}` : "",
      ]
        .filter(Boolean)
        .join(" "),
    );
  }
  const locatorFailure = parseLocatorResolutionFailure(input.failureMessage);
  if (locatorFailure) {
    parts.push(
      `Locator resolution attempted selectors: ${locatorFailure.attemptedSelectors.join(" | ") || "(none)"}`,
    );
    if (locatorFailure.failures.length) {
      parts.push(`Locator resolution failures: ${locatorFailure.failures.join(" || ")}`);
    }
  }
  const pathMismatch = parsePathMismatch(input.failureMessage);
  if (pathMismatch) {
    parts.push(`Path mismatch: expected=${pathMismatch.expectedPath} actual=${pathMismatch.actualPath}`);
  }
  if (input.errorContextSnippet) {
    parts.push(`Error context excerpt: ${input.errorContextSnippet.slice(0, 500)}`);
  }
  const visualArtifacts = input.artifacts
    .filter((artifact) => artifact.type === "screenshot" || artifact.type === "trace" || artifact.type === "video")
    .slice(0, 6)
    .map((artifact) => `[${artifact.type}] ${artifact.path}`);
  if (visualArtifacts.length) {
    parts.push(`Artifacts: ${visualArtifacts.join(" | ")}`);
  }
  return parts.filter(Boolean).join("\n");
}

function extractSelectedTestSnippet(specContent: string | undefined, title: string | null | undefined) {
  if (!specContent || !title) return undefined;
  const starts = [`test("${title}"`, `test('${title}'`, `test(\`${title}\``]
    .map((needle) => specContent.indexOf(needle))
    .filter((idx) => idx >= 0)
    .sort((a, b) => a - b);
  const start = starts[0];
  if (start == null || start < 0) return undefined;
  const nextStart = specContent.indexOf("\n\ntest(", start + 1);
  const end = nextStart >= 0 ? nextStart : specContent.length;
  return specContent.slice(start, end);
}

export async function buildAiExecutionContext(
  job: SelfHealPayload,
  mode: AiActionMode = "autonomous"
): Promise<AiExecutionContext> {
  const logRoots = [
    path.join(REPORT_ROOT, "runner-logs"),
    REPORT_ROOT,
    path.join(process.cwd(), "runner-logs"),
    path.join(process.cwd(), "apps", "api", "runner-logs"),
  ];
  const runLogDir =
    logRoots.find((root) => existsSync(path.join(root, job.runId))) ??
    path.join(REPORT_ROOT, "runner-logs", job.runId);
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

  const key = result?.testCase?.key ?? fallbackCase?.key ?? null;
  if (!key) {
    throw new Error(
      `TestCase ${job.testCaseId} not found or has no spec key — self-heal cannot locate the spec file`
    );
  }
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
    const candidates = buildSpecCandidates(repoRoot, normalizedSpecPath, runSpecPathRaw, effectiveAdapterId, job.projectId);
    preferredAbsolutePath = await findExistingPath(candidates);
  }

  const repoAbsolutePath = preferredAbsolutePath ?? path.join(repoRoot, normalizedSpecPath);
  const repoRelativePath = preferredAbsolutePath
    ? toPosix(path.relative(repoRoot, preferredAbsolutePath))
    : toPosix(normalizedSpecPath);

  const repoSpecContent = await fs.readFile(repoAbsolutePath, "utf8").catch(() => undefined);
  const runSpecContent = await fs.readFile(runSpecPathRaw, "utf8").catch(() => undefined);
  const rawTitle = result?.testCase?.title ?? fallbackCase?.title ?? job.testTitle ?? null;
  const selectedTestSnippet = extractSelectedTestSnippet(
    repoSpecContent ?? runSpecContent,
    rawTitle,
  );
  const reportSnippet = await readSnippet(path.join(runLogDir, "report.json"), 4000);
  const pageSignalsSnippet = await readSnippet(path.join(runLogDir, "page-signals.json"), 8000);
  const evidenceArtifacts = await collectEvidenceArtifacts(runLogDir, normalizedSpecPath);
  const errorContextSnippet =
    evidenceArtifacts.find((artifact) => artifact.type === "error-context")?.excerpt ?? "";
  const failureMessage = result?.message;
  const structuredSummary = buildStructuredEvidenceSummary({
    failureMessage,
    pageSignalsSnippet,
    errorContextSnippet,
    artifacts: evidenceArtifacts,
  });
  const failureClasses = classifyFailureContext({
    message: failureMessage,
    specContent: repoSpecContent ?? runSpecContent ?? "",
    stdout,
    stderr,
    testTitle: rawTitle,
  });

  return {
    mode,
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
    selectedTestSnippet,
    failure: {
      stdout,
      stderr,
      message: failureMessage,
      testTitle: extractTestTitle(rawTitle),
    },
    evidence: {
      reportSnippet,
      pageSignalsSnippet,
      errorContextSnippet,
      structuredSummary,
      artifacts: evidenceArtifacts,
      failureClasses,
    },
  };
}
