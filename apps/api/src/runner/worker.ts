import { Worker, Job } from 'bullmq';
import path from 'path';
import fs from 'fs/promises';
import fsSync from 'fs';
import { prisma } from '../prisma.js';
import { redis } from './redis.js';
import { makeWorkdir, rmrf } from './workdir.js';
import { cloneRepo } from './git.js';
import { detectFramework, installDeps, runTests } from './node-test-exec.js';
import { parseResults } from './result-parsers.js';
import { scheduleSelfHealingForRun } from './self-heal.js';
import type { RunPayload } from './queue.js';
import { analyzeFailure } from './ai-analysis.js';
import type { LocatorBucket } from '../testmind/runtime/locator-store.js';
import { REPORT_ROOT } from '../lib/storageRoots.js';

type RunStatus = "queued" | "running" | "succeeded" | "failed";
type ResultStatus = "passed" | "failed" | "skipped" | "error";
const TestRunStatus: Record<RunStatus, RunStatus> = {
  queued: "queued",
  running: "running",
  succeeded: "succeeded",
  failed: "failed",
};
const TestResultStatus: Record<ResultStatus, ResultStatus> = {
  passed: "passed",
  failed: "failed",
  skipped: "skipped",
  error: "error",
};

function mapStatus(s: string): ResultStatus {
  if (s === 'passed') return TestResultStatus.passed;
  if (s === 'failed' || s === 'error') return TestResultStatus.failed;
  if (s === 'skipped') return TestResultStatus.skipped;
  return TestResultStatus.error;
}

const stripAnsi = (value?: string | null) =>
  typeof value === 'string' ? value.replace(/\u001b\[[0-9;]*m/g, '') : value ?? null;

const filterRunnerError = (value?: string | null) => {
  if (!value) return null;
  const cleaned = stripAnsi(value)
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .filter((line) => !/^npm notice\b/i.test(line))
    .filter((line) => !/New major version of npm available!/i.test(line))
    .join("\n")
    .trim();
  return cleaned || null;
};

type MissingLocatorItem = {
  pagePath: string;
  bucket: LocatorBucket;
  name: string;
  stepText: string;
  suggestions: string[];
};

function extractNavTargetFromTitle(title?: string | null): string | null {
  if (!title) return null;
  const match = title.match(/Navigate\s+[^→-]+(?:→|->)\s+([^\s]+)/i);
  const target = match?.[1]?.trim() ?? "";
  if (!target || !target.startsWith("/")) return null;
  return target;
}

function navKeyFromPath(path: string): string {
  if (path === "/") return "nav.home";
  const cleaned = path.replace(/^\//, "");
  const kebab = cleaned
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return kebab ? `nav.${kebab}` : "nav.home";
}

function navSuggestions(path: string): string[] {
  const target = path || "/";
  return Array.from(
    new Set([`a[href="${target}"]`, `a[href^="${target}"]`])
  );
}

function generateSelectorSuggestions(rawName: string): string[] {
  const candidates: string[] = [];
  const push = (value?: string) => {
    if (!value) return;
    const trimmed = value.trim();
    if (!trimmed) return;
    candidates.push(trimmed);
  };

  const safeText = rawName?.trim();
  const looksLikeSelector = /[#.[\]=:]/.test(safeText || "");
  if (looksLikeSelector) {
    push(safeText);
  }

  if (safeText && safeText.length <= 80) {
    push(`text=${safeText.replace(/"/g, '\\"')}`);
  }

  const normalized = rawName.replace(/[^a-z0-9]/gi, "");
  if (normalized && normalized.length <= 32) {
    push(`input[name="${normalized}"]`);
    push(`input[placeholder*="${normalized}"]`);
    push(`[data-testid*="${normalized}"]`);
  }

  push("input");
  push("button");
  return Array.from(new Set(candidates));
}

function cleanLocatorArg(value: string): string {
  let raw = value.trim();
  if (raw.startsWith('/') && raw.lastIndexOf('/') > 0) {
    const lastSlash = raw.lastIndexOf('/');
    raw = raw.slice(1, lastSlash);
  }
  if (
    (raw.startsWith("'") && raw.endsWith("'")) ||
    (raw.startsWith('"') && raw.endsWith('"'))
  ) {
    raw = raw.slice(1, -1);
  }
  return raw.trim();
}

function extractLocatorExpression(message?: string | null, steps?: string[]): string | null {
  const raw = `${message ?? ''}\n${(steps ?? []).join('\n')}`;
  const locatorLine = raw.match(/Locator:\s*(.+)$/im);
  if (locatorLine?.[1]) return locatorLine[1].trim();
  const waitLine = (steps ?? []).find((line) => /waiting for /i.test(line));
  if (waitLine) {
    const match = waitLine.match(/waiting for\s+(.+)$/i);
    if (match?.[1]) return match[1].trim();
  }
  const exprMatch = raw.match(
    /(getByText\([^)]+\)|getByRole\([^)]+\)|getByLabel\([^)]+\)|getByPlaceholder\([^)]+\)|getByTestId\([^)]+\)|locator\([^)]+\))/i
  );
  return exprMatch?.[1]?.trim() ?? null;
}

function extractLocatorName(expr: string): string {
  const locatorMatch = expr.match(/locator\((.+)\)/i);
  if (locatorMatch?.[1]) return cleanLocatorArg(locatorMatch[1]);
  const textMatch = expr.match(/getByText\((.+)\)/i);
  if (textMatch?.[1]) return cleanLocatorArg(textMatch[1]);
  const roleMatch = expr.match(/getByRole\((.+)\)/i);
  if (roleMatch?.[1]) return cleanLocatorArg(roleMatch[1]);
  const labelMatch = expr.match(/getByLabel\((.+)\)/i);
  if (labelMatch?.[1]) return cleanLocatorArg(labelMatch[1]);
  const placeholderMatch = expr.match(/getByPlaceholder\((.+)\)/i);
  if (placeholderMatch?.[1]) return cleanLocatorArg(placeholderMatch[1]);
  const testIdMatch = expr.match(/getByTestId\((.+)\)/i);
  if (testIdMatch?.[1]) return cleanLocatorArg(testIdMatch[1]);
  return expr;
}

function pagePathFromTitle(title?: string | null): string {
  if (!title) return '/';
  const direct = title.match(/(?:Page loads:|Navigate)\s+([^ ]+)/i);
  if (direct?.[1]) return direct[1].trim();
  const pathMatch = title.match(/(\/[a-z0-9/_-]+)(?:\b|$)/i);
  return pathMatch?.[1]?.trim() || '/';
}

function isPageLoadTitle(title?: string | null): boolean {
  if (!title) return false;
  return /Page loads:/i.test(title);
}

function isMissingLocatorFailure(message?: string | null, steps?: string[]): boolean {
  const raw = `${message ?? ''}\n${(steps ?? []).join('\n')}`;
  if (!raw.trim()) return false;
  if (
    !/toBeVisible/i.test(raw) &&
    !/element\(s\) not found/i.test(raw) &&
    !/waiting for /i.test(raw) &&
    !/locator\.waitFor/i.test(raw)
  ) {
    return false;
  }
  return /getByText|getByRole|getByLabel|getByPlaceholder|getByTestId|locator\(/i.test(raw);
}

async function appendMissingLocators(
  filePath: string,
  items: MissingLocatorItem[]
): Promise<void> {
  if (!items.length) return;
  let payload: { items: MissingLocatorItem[] } = { items: [] };
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed?.items)) payload.items = parsed.items;
  } catch (err: any) {
    if (err?.code !== 'ENOENT') {
      console.error('[missing-locators] failed to read', { filePath, error: err });
    }
  }
  payload.items.push(...items);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf8');
}

const DEFAULT_BASE_URL = process.env.TM_BASE_URL ?? process.env.BASE_URL ?? "http://localhost:4173";

export const worker = new Worker(
  'test-runs',
  async (job: Job) => {
    const { runId, payload } = job.data as { runId: string; payload?: RunPayload };

    const run = await prisma.testRun.findUnique({
      where: { id: runId },
      select: {
        project: { select: { id: true, ownerId: true, repoUrl: true } },
        paramsJson: true,
      },
    });
    if (!run || !run.project?.repoUrl) {
      throw new Error('Run or project/repoUrl not found');
    }

    await prisma.testRun.update({
      where: { id: runId },
      data: {
        status: TestRunStatus.running,
        startedAt: new Date(),
      },
    });

    const project = run.project;
    const runParams = (run.paramsJson as Record<string, any> | undefined) ?? undefined;
    const targetSpec =
      payload?.file ?? runParams?.targetSpec ?? runParams?.file ?? undefined;
    const fileTarget = targetSpec;
    const localRepoRoot =
      payload?.localRepoRoot ?? runParams?.localRepoRoot ?? undefined;
    const prevLocalRepoRoot = process.env.TM_LOCAL_REPO_ROOT;
    const localRootInjected = Boolean(localRepoRoot);
    if (localRootInjected) {
      process.env.TM_LOCAL_REPO_ROOT = localRepoRoot!;
    }

    const outDir = path.join(REPORT_ROOT, 'runner-logs', runId);
    await fs.mkdir(outDir, { recursive: true });

    const work = await makeWorkdir();
    try {
      // GitHub token if connected
      const gitAcct = await prisma.gitAccount.findFirst({
        where: { userId: project.ownerId, provider: 'github' },
        select: { token: true },
      });

      // 1) Clone
      await cloneRepo(project.repoUrl, work, gitAcct?.token || undefined);

      // 2) Install deps
      await installDeps(work);

      // 3) Detect + run
      const framework = await detectFramework(work);
      const resultsPath = path.join(outDir, 'report.json');
      const webDir = path.join(work, 'apps', 'web');
      const extraGlobs: string[] = [];
      const grep = payload?.grep;
      const normalizedFileTarget = fileTarget?.replace(/\\/g, "/");
      let specPath = normalizedFileTarget;
      if (specPath?.startsWith("apps/web/")) {
        specPath = specPath.slice("apps/web/".length);
      }
      if (specPath) {
        const isAbs = path.isAbsolute(specPath);
        const isWebGenerated = /[\\/]+apps[\\/]+web[\\/]+testmind-generated[\\/]+/i.test(specPath);
        let abs = isAbs ? specPath : path.join(webDir, specPath);
        if (isAbs && isWebGenerated) {
          const relativeFromWeb = path.relative(webDir, specPath);
          const repoCandidate = path.join(work, relativeFromWeb);
          if (fsSync.existsSync(repoCandidate)) {
            abs = repoCandidate;
          }
        }
        if (!isAbs && !fsSync.existsSync(abs)) {
          const repoCandidate = path.join(work, specPath);
          if (fsSync.existsSync(repoCandidate)) {
            abs = repoCandidate;
          }
        }
        const rel = path.relative(webDir, abs).replace(/\\/g, "/");
        // If the spec sits outside apps/web, pass absolute path so Playwright can find it.
        if (rel.startsWith("..")) {
          extraGlobs.push(abs.replace(/\\/g, "/"));
        } else {
          extraGlobs.push(rel);
        }
      }
      const loggedFile = specPath ?? normalizedFileTarget ?? fileTarget ?? "";

      const jobBaseUrl = payload?.baseUrl ?? DEFAULT_BASE_URL;
      const timeoutMs = payload?.timeoutMs ?? runParams?.timeoutMs ?? 30_000;
      const exec = await runTests({
        workdir: webDir,
        jsonOutPath: resultsPath,
        headed: payload?.headed,
        grep,
        extraGlobs,
        baseUrl: jobBaseUrl,
        runTimeout: timeoutMs,
      });

      // write logs
      await fs.writeFile(
        path.join(outDir, "stdout.txt"),
        `[worker] headful=${payload?.headed ? "true" : "false"} file=${loggedFile} grep=${grep || ""} baseUrl=${jobBaseUrl}\n${exec.stdout ?? ""}`,
        { flag: "w" }
      );
      await fs.writeFile(path.join(outDir, 'stderr.txt'), exec.stderr ?? '');

      // 4) Parse → DB
      let parsedCount = 0;
      let failed = 0;
      let passed = 0;
      let skipped = 0;

      if (exec.resultsPath) {
        const cases = await parseResults(exec.resultsPath);
        const missingLocators: MissingLocatorItem[] = [];

        for (const c of cases) {
          if (c.status !== 'failed' && c.status !== 'error') continue;
          if (/toHaveURL/i.test(c.message ?? "")) {
            const navTarget = extractNavTargetFromTitle(c.fullName ?? null);
            if (navTarget) {
              missingLocators.push({
                pagePath: "__global_nav__",
                bucket: "locators",
                name: navKeyFromPath(navTarget),
                stepText: c.fullName ?? `Navigate to ${navTarget}`,
                suggestions: navSuggestions(navTarget),
              });
            }
          }
          if (!isMissingLocatorFailure(c.message ?? null, c.steps ?? [])) continue;
          if (isPageLoadTitle(c.fullName ?? null)) {
            const locatorExpr = extractLocatorExpression(c.message ?? null, c.steps ?? []);
            if (locatorExpr) {
              const locatorName = extractLocatorName(locatorExpr);
              missingLocators.push({
                pagePath: pagePathFromTitle(c.fullName ?? null),
                bucket: 'locators',
                name: 'pageIdentity',
                stepText: c.fullName ?? 'Page loads',
                suggestions: generateSelectorSuggestions(locatorName || 'pageIdentity'),
              });
              continue;
            }
          }
          const locatorExpr = extractLocatorExpression(c.message ?? null, c.steps ?? []);
          if (!locatorExpr) continue;
          const name = extractLocatorName(locatorExpr);
          missingLocators.push({
            pagePath: pagePathFromTitle(c.fullName ?? null),
            bucket: 'locators',
            name,
            stepText: c.steps?.join('\n') || c.fullName || name,
            suggestions: generateSelectorSuggestions(name),
          });
        }

        await appendMissingLocators(path.join(outDir, 'missing-locators.json'), missingLocators);

        await prisma.$transaction(async (db) => {
          for (const c of cases) {
            const key = `${c.file}#${c.fullName}`.slice(0, 255);

            const testCase = await db.testCase.upsert({
              where: { projectId_key: { projectId: project.id, key } },
              update: { title: c.fullName },
              create: { projectId: project.id, key, title: c.fullName },
            });

            await db.testResult.create({
              data: {
                run: { connect: { id: runId } },
                testCase: { connect: { id: testCase.id } },
                status: mapStatus(c.status),
                durationMs: c.durationMs ?? null,
                message: c.message ?? null,
              },
            });

            parsedCount++;
            if (c.status === 'passed') passed++;
            else if (c.status === 'failed' || c.status === 'error') failed++;
            else skipped++;
          }
        });
      }

      const ok = failed === 0 && exec.ok;
      if (!ok) {
        await analyzeFailure({
          runId,
          outDir,
          stderr: exec.stderr ?? undefined,
          stdout: exec.stdout ?? undefined,
          reportPath: exec.resultsPath ?? resultsPath,
          grep,
          file: payload?.file,
          baseUrl: jobBaseUrl,
        });
      }
      await prisma.testRun.update({
        where: { id: runId },
        data: {
          status: ok ? TestRunStatus.succeeded : TestRunStatus.failed,
          finishedAt: new Date(),
          summary: JSON.stringify({ framework, parsedCount, passed, failed, skipped }),
          error: ok ? null : (filterRunnerError(exec.stderr) || 'Test command failed'),
        },
      });

      if (!ok && failed > 0) {
        scheduleSelfHealingForRun(runId).catch((err) => {
          console.error(`[worker] failed to schedule self-heal for run ${runId}`, err);
        });
      }
    } catch (err: any) {
      await prisma.testRun.update({
        where: { id: runId },
        data: {
          status: TestRunStatus.failed,
          finishedAt: new Date(),
          error: stripAnsi(err?.message ?? String(err)),
        },
      });
      throw err;
    } finally {
      await rmrf(work).catch(() => {});
      if (localRootInjected) {
        if (prevLocalRepoRoot === undefined) {
          delete process.env.TM_LOCAL_REPO_ROOT;
        } else {
          process.env.TM_LOCAL_REPO_ROOT = prevLocalRepoRoot;
        }
      }
    }
  },
  { connection: redis }
);

worker.on('failed', (job, err) => {
  const runId = job?.data?.runId;
  console.error(`[worker] job ${job?.id} (run ${runId ?? 'unknown'}) failed:`, err);
});

worker.on('completed', (job) => {
  const runId = job?.data?.runId;
  console.log(`[worker] job ${job?.id} (run ${runId ?? 'unknown'}) completed`);
});
