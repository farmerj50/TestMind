import "dotenv/config";
import { Worker, Job } from 'bullmq';
import path from 'path';
import fs from 'fs/promises';
import { existsSync } from 'node:fs';
import { createTwoFilesPatch } from 'diff';
import { redis } from './redis.js';
import { prisma } from '../prisma.js';
import type { SelfHealPayload, RunPayload } from './queue.js';
import { enqueueRun } from './queue.js';
import { requestSpecHeal, HealPrompt } from './llm.js';
import { CURATED_ROOT } from "../testmind/curated-store.js";
import { extractTestTitle } from './test-title.js';

const TestRunStatus = {
  queued: "queued",
  running: "running",
  succeeded: "succeeded",
  failed: "failed",
} as const;

const HealingStatus = {
  queued: "queued",
  running: "running",
  succeeded: "succeeded",
  failed: "failed",
} as const;

const toPosix = (value: string) => value.replace(/\\/g, "/");

function guessRepoRoot() {
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

function buildSpecCandidates(repoRoot: string, normalizedSpecPath: string, rawPath: string) {
  const fallback = normalizedSpecPath || "unknown-spec";
  const candidates = new Set<string>();
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
  candidates.add(
    path.join(
      repoRoot,
      "apps",
      "web",
      "testmind-generated",
      "playwright-ts",
      path.basename(fallback)
    )
  );
  candidates.add(
    path.join(
      repoRoot,
      "apps",
      "api",
      "testmind-generated",
      "playwright-ts",
      path.basename(fallback)
    )
  );
  if (process.env.TM_LOCAL_SPECS) {
    const localSpecsRoot = path.resolve(process.env.TM_LOCAL_SPECS);
    if (normalizedSpecPath) {
      candidates.add(path.join(localSpecsRoot, normalizedSpecPath));
    }
    candidates.add(path.join(localSpecsRoot, path.basename(fallback)));
  }
  return Array.from(candidates);
}

async function findExistingPath(paths: string[]): Promise<string | null> {
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

async function triggerRerun(
  projectId: string,
  rerunOfId: string,
  grep?: string,
  headed?: boolean,
  baseUrl?: string,
  localRepoRoot?: string,
  targetSpec?: string,
  options?: { healOnly?: boolean }
) {
  const projectRecord = await prisma.project.findUnique({
    where: { id: projectId },
    select: { sharedSteps: true },
  });
  const sharedSteps = projectRecord?.sharedSteps;
  const params: Record<string, any> = {};
  if (headed !== undefined) params.headful = headed;
  if (baseUrl) params.baseUrl = baseUrl;
  if (sharedSteps !== undefined) params.sharedSteps = sharedSteps;
  if (localRepoRoot) params.localRepoRoot = localRepoRoot;
  if (targetSpec) params.targetSpec = targetSpec;
  const rerun = await prisma.testRun.create({
    data: {
      projectId,
      rerunOfId,
      status: TestRunStatus.running,
      startedAt: new Date(),
      trigger: "self-heal",
      paramsJson: Object.keys(params).length ? params : undefined,
    },
  });

  if (options?.healOnly) {
    console.log(
      `[self-heal] heal-only mode: skipping rerun queue for ${targetSpec ?? "full suite"} (run ${rerun.id})`
    );
    return;
  }

  const payload: RunPayload = {
    projectId,
    localRepoRoot,
    file: targetSpec,
  };
  if (grep) payload.grep = grep;
  if (headed !== undefined) payload.headed = headed;

  try {
    await enqueueRun(rerun.id, payload);
    console.log(
      "[self-heal] queued rerun",
      rerun.id,
      "grep:",
      grep ?? "(full suite)",
      "headed:",
      headed ?? "(default)"
    );
  } catch (err) {
    console.error(`[self-heal] failed to enqueue rerun ${rerun.id}:`, err);
    throw err;
  }
}

type FailureContext = {
  repoRelativePath: string;
  repoAbsolutePath: string;
  repoRoot: string;
  runSpecPath?: string;
  specContent?: string;
  stdout?: string;
  stderr?: string;
  message?: string | null;
  testTitle?: string | null;
};

function containsNavTimeout(msg?: string | null) {
  if (!msg) return false;
  const lower = msg.toLowerCase();
  return lower.includes("page.goto") && lower.includes("timeout");
}

function containsStrictMode(msg?: string | null) {
  if (!msg) return false;
  const lower = msg.toLowerCase();
  return (
    lower.includes("strict mode") ||
    lower.includes("resolved to") ||
    lower.includes("matches 2 elements")
  );
}

function isInfraError(msg?: string | null) {
  if (!msg) return false;
  return INFRA_ERROR_PATTERNS.some((pattern) => pattern.test(msg));
}

async function collectFailureContext(job: SelfHealPayload): Promise<FailureContext> {
  const runLogDir = path.join(process.cwd(), 'runner-logs', job.runId);
  const stdoutPath = path.join(runLogDir, 'stdout.txt');
  const stderrPath = path.join(runLogDir, 'stderr.txt');

  const [stdout, stderr, result] = await Promise.all([
    fs.readFile(stdoutPath, 'utf8').catch(() => ''),
    fs.readFile(stderrPath, 'utf8').catch(() => ''),
    prisma.testResult.findUnique({
      where: { id: job.testResultId },
      select: { message: true, testCase: { select: { key: true, title: true } } },
    }),
  ]);

  const key = result?.testCase?.key ?? job.testCaseId ?? 'unknown-spec';
  const runSpecPathRaw = key.split("#")[0] || key;
  const runSpecPath = runSpecPathRaw.replace(/\\/g, "/");
  const normalizedSpecPath = runSpecPath.replace(/^\.?\/+/, "").replace(/^\/+/, "") || "unknown-spec";
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
    const candidates = buildSpecCandidates(repoRoot, normalizedSpecPath, runSpecPathRaw);
    preferredAbsolutePath = await findExistingPath(candidates);
  }

  const repoAbsolutePath =
    preferredAbsolutePath ?? path.join(repoRoot, normalizedSpecPath);
  const relativeForDiff = preferredAbsolutePath
    ? toPosix(path.relative(repoRoot, preferredAbsolutePath))
    : toPosix(normalizedSpecPath);

  const repoSpecContent = await fs.readFile(repoAbsolutePath, "utf8").catch(() => undefined);
  const runSpecContent = await fs.readFile(runSpecPathRaw, "utf8").catch(() => undefined);
  const specContent = repoSpecContent ?? runSpecContent;
  const rawTitle = result?.testCase?.title ?? job.testTitle ?? null;
  const testTitle = extractTestTitle(rawTitle);

  return {
    repoRelativePath: relativeForDiff,
    repoAbsolutePath,
    repoRoot,
    runSpecPath: runSpecContent ? runSpecPathRaw : undefined,
    specContent,
    stdout,
    stderr,
    message: result?.message,
    testTitle,
  };
}

const SELF_HEAL_CONCURRENCY = Number(process.env.SELF_HEAL_CONCURRENCY ?? '1');
const SELF_HEAL_TIMEOUT_MS = Number(process.env.SELF_HEAL_TIMEOUT_MS ?? '120000');
const SELF_HEAL_HEAL_ONLY = (process.env.SELF_HEAL_HEAL_ONLY ?? "0") === "1";
const INFRA_ERROR_PATTERNS = [
  /net::/i,
  /disconnected/i,
  /chrome.*not reachable/i,
  /connection refused/i,
  /socket hang up/i,
];

async function withTimeout<T>(promise: Promise<T>, ms: number) {
  return Promise.race<T>([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`self-heal timeout after ${ms}ms`)), ms)
    ),
  ]);
}

export const selfHealWorker = new Worker(
  'self-heal',
  async (job: Job<SelfHealPayload>) => {
    const { attemptId } = job.data;

    await prisma.testHealingAttempt.update({
      where: { id: attemptId },
      data: { status: HealingStatus.running },
    });

    try {
      const context = await collectFailureContext(job.data);
      if (!context.specContent) {
        throw new Error(`Spec file not found for ${context.repoRelativePath}`);
      }

      const writeAndRecordSuccess = async (patched: string, summary: string, note: string) => {
        await fs.mkdir(path.dirname(context.repoAbsolutePath), { recursive: true });
        await fs.writeFile(context.repoAbsolutePath, patched, "utf8");
        const diff = createTwoFilesPatch(
          context.repoRelativePath,
          context.repoRelativePath,
          context.specContent!,
          patched
        );
        await prisma.testHealingAttempt.update({
          where: { id: attemptId },
          data: {
            status: HealingStatus.succeeded,
            summary,
            diff,
            prompt: { note },
            response: { raw: note },
          },
        });
        await triggerRerun(
          job.data.projectId,
          job.data.runId,
          context.testTitle ?? undefined,
          job.data.headed,
          job.data.baseUrl,
          context.repoRoot,
          context.repoRelativePath,
          { healOnly: SELF_HEAL_HEAL_ONLY }
        );
      };

      // Quick rule-based nav URL fix before invoking LLM
      const gotoMatch = context.specContent.match(/page\.goto\(\s*["']([^"']+)["']\s*\)/);
      const originalUrl = gotoMatch?.[1];
      const normalizeUrl = (raw: string) => {
        try {
          const u = new URL(raw);
          let host = u.hostname;
          if (host.endsWith(".com.com")) host = host.replace(/\.com\.com$/, ".com");
          const tldFix = host.match(/\.([a-z]{2,3})\.com$/);
          if (tldFix) host = host.replace(/\.([a-z]{2,3})\.com$/, ".$1");
          if (host !== u.hostname) {
            u.hostname = host;
            return u.toString();
          }
        } catch {
          // ignore parse errors
        }
        return null;
      };

      let didNavPatch = false;
      let navPatchedSpec = context.specContent;
      if (originalUrl) {
        const fixed = normalizeUrl(originalUrl);
        if (fixed && fixed !== originalUrl) {
          navPatchedSpec = navPatchedSpec.replace(originalUrl, fixed);
          // add gentle waitUntil/timeout if not present
          navPatchedSpec = navPatchedSpec.replace(
            /page\.goto\(\s*["'][^"']+["']\s*\)/,
            `page.goto(${JSON.stringify(fixed)}, { waitUntil: "domcontentloaded", timeout: 20000 })`
          );
          didNavPatch = true;
        }
      }

      if (didNavPatch) {
        await writeAndRecordSuccess(navPatchedSpec, "Auto-fixed navigation URL", "rule-based url fix");
        return;
      }

      // Rule: bump nav timeout/waitUntil on navigation timeouts
      if (containsNavTimeout(context.message)) {
        const gotoWithOpts = /page\.goto\(\s*([^,]+)\s*,\s*{[^}]*timeout\s*:\s*(\d+)/m;
          const gotoSimple = /page\.goto\(\s*([A-Za-z0-9_.$]+)\s*\)/m;
        let patched = context.specContent;
        let updated = false;

        const replaceWith = (urlLiteral: string) =>
          `page.goto(${urlLiteral.trim()}, { waitUntil: "domcontentloaded", timeout: 20000 })`;

        const mOpts = context.specContent.match(gotoWithOpts);
        if (mOpts) {
          const currentTimeout = Number(mOpts[2]);
          if (!Number.isNaN(currentTimeout) && currentTimeout < 10000) {
            patched = context.specContent.replace(gotoWithOpts, (_, urlLit) => replaceWith(urlLit));
            updated = true;
          }
        } else {
          const mSimple = context.specContent.match(gotoSimple);
          if (mSimple) {
            patched = context.specContent.replace(gotoSimple, (_, urlLit) => replaceWith(urlLit));
            updated = true;
          }
        }

        if (updated) {
          await writeAndRecordSuccess(patched, "Auto-increased navigation timeout", "rule-based nav-timeout");
          return;
        }
      }

      // Rule: handle strict-mode locator errors
      if (containsStrictMode(context.message)) {
        const hrefMatch = context.message?.match(/href="([^"]+)"/);
        if (hrefMatch) {
          const href = hrefMatch[1];
          const locatorLinePattern =
            /(page\.(locator|getByRole|getByText|getByLabel|getByTestId|getByPlaceholder|getByAltText)\([^;]+?\))/m;
          const locatorMatch = context.specContent.match(locatorLinePattern);
          if (locatorMatch) {
            const original = locatorMatch[0];
            const replacement = `page.locator('a[href="${href}"]').first()`;
            const patched = context.specContent.replace(original, replacement);
            await writeAndRecordSuccess(
              patched,
              `Auto-fixed strict-mode locator via href=${href}`,
              "rule-based strict-mode href"
            );
            return;
          }
        }
        const locatorPattern =
          /page\.(locator|getByRole|getByText|getByLabel|getByTestId|getByPlaceholder|getByAltText)\([^;]+?\)(?!\s*\.(first|nth|filter|locator))/m;
        const match = context.specContent.match(locatorPattern);
        if (match) {
          const target = match[0];
          const patchedLocator = `${target}.first()`;
          const patched = context.specContent.replace(target, patchedLocator);
          await writeAndRecordSuccess(
            patched,
            "Auto-selected first match for strict-mode locator",
            "rule-based strict-mode"
          );
          return;
        }
      }

      const promptPayload: HealPrompt = {
        specPath: context.repoRelativePath,
        failureMessage: context.message,
        stdout: (context.stdout || '').slice(0, 4000),
        stderr: (context.stderr || '').slice(0, 4000),
        specContent: context.specContent,
      };

      console.log(
        `[self-heal] starting attempt ${attemptId} for run ${job.data.runId} (testResult=${job.data.testResultId})`
      );

      const healResult = await withTimeout(requestSpecHeal(promptPayload), SELF_HEAL_TIMEOUT_MS);
      await fs.mkdir(path.dirname(context.repoAbsolutePath), { recursive: true });
      await fs.writeFile(context.repoAbsolutePath, healResult.updatedSpec, 'utf8');

      const diff = createTwoFilesPatch(
        context.repoRelativePath,
        context.repoRelativePath,
        context.specContent,
        healResult.updatedSpec
      );

      await prisma.testHealingAttempt.update({
        where: { id: attemptId },
        data: {
          status: HealingStatus.succeeded,
          summary: healResult.summary,
          diff,
          prompt: promptPayload,
          response: { raw: healResult.raw },
        },
      });
      console.log(
        `[self-heal] finished attempt ${attemptId} for run ${job.data.runId} (status=succeeded)`
      );

      if (isInfraError(context.message)) {
        console.log(
          `[self-heal] detected infra-like failure for run ${job.data.runId}; skipping rerun`
        );
        return;
      }

      if (job.data.totalFailed <= 1) {
        await triggerRerun(
          job.data.projectId,
          job.data.runId,
          context.testTitle ?? undefined,
          job.data.headed,
          job.data.baseUrl,
          context.repoRoot,
          context.repoRelativePath,
          { healOnly: SELF_HEAL_HEAL_ONLY }
        );
      } else {
        const remaining = await prisma.testHealingAttempt.count({
          where: { runId: job.data.runId, status: { not: HealingStatus.succeeded } },
        });
        if (remaining === 0) {
          await triggerRerun(
            job.data.projectId,
            job.data.runId,
            undefined,
            job.data.headed,
            job.data.baseUrl,
            context.repoRoot,
            context.repoRelativePath,
            { healOnly: SELF_HEAL_HEAL_ONLY }
          );
        }
      }
    } catch (err: any) {
      await prisma.testHealingAttempt.update({
        where: { id: attemptId },
        data: {
          status: HealingStatus.failed,
          error: err?.message ?? String(err),
        },
      });
      console.error(`[self-heal] attempt ${attemptId} failed:`, err);
      throw err;
    }
  },
  { connection: redis, concurrency: SELF_HEAL_CONCURRENCY }
);

selfHealWorker.on('failed', (job, err) => {
  console.error(`[self-heal] job ${job?.id} failed:`, err);
});

selfHealWorker.on('completed', (job) => {
  console.log(
    `[self-heal] job ${job?.id} (run ${job?.data?.runId ?? 'unknown'}) completed`
  );
});
