import "dotenv/config";
import { Worker, Job } from 'bullmq';
import path from 'path';
import fs from 'fs/promises';
import { createTwoFilesPatch } from 'diff';
import { redis } from './redis';
import { prisma } from '../prisma';
import type { SelfHealPayload, RunPayload } from './queue';
import { enqueueRun } from './queue';
import { requestSpecHeal, HealPrompt } from './llm';
import { CURATED_ROOT } from "../testmind/curated-store";

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

async function triggerRerun(projectId: string, rerunOfId: string, grep?: string, headed?: boolean) {
  const rerun = await prisma.testRun.create({
    data: {
      projectId,
      rerunOfId,
      status: TestRunStatus.running,
      startedAt: new Date(),
      trigger: "self-heal",
      paramsJson: headed !== undefined ? { headful: headed } : undefined,
    },
  });

  const payload: RunPayload = { projectId };
  if (grep) payload.grep = grep;
  if (headed !== undefined) payload.headed = headed;

  await enqueueRun(rerun.id, payload);
  console.log("[self-heal] queued rerun", rerun.id, "grep =", grep ?? "(full suite)");
}

type FailureContext = {
  repoRelativePath: string;
  repoAbsolutePath: string;
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

  let repoRelativePath = runSpecPath;
  const anchor = runSpecPath.indexOf("testmind-generated/");
  if (anchor >= 0) {
    const remainder = runSpecPath
      .slice(anchor)
      .replace(/\\/g, "/")
      .split("/")
      .filter(Boolean);
    repoRelativePath = path.join("apps", "api", ...remainder);
  } else if (!runSpecPath.startsWith("apps/")) {
    repoRelativePath = path.join(
      "apps",
      "api",
      "testmind-generated",
      "playwright-ts",
      path.basename(runSpecPath)
    );
  }

  let preferredAbsolutePath: string | null = null;
  if (runSpecPath.includes("__agent/agent-")) {
    const match = runSpecPath.match(/__agent\/(agent-[^/]+)(\/.*)?$/);
    if (match) {
      const suiteId = match[1];
      const remainder = match[2]?.replace(/^\/+/, "") ?? "";
      preferredAbsolutePath = path.join(CURATED_ROOT, suiteId, remainder);
    }
  }

  const repoAbsolutePath = preferredAbsolutePath
    ? preferredAbsolutePath
    : path.join(process.cwd(), repoRelativePath);
  const relativeForDiff = preferredAbsolutePath
    ? path.relative(process.cwd(), preferredAbsolutePath)
    : repoRelativePath;

  const repoSpecContent = await fs.readFile(repoAbsolutePath, "utf8").catch(() => undefined);
  const runSpecContent = await fs.readFile(runSpecPathRaw, "utf8").catch(() => undefined);
  const specContent = repoSpecContent ?? runSpecContent;

  return {
    repoRelativePath: relativeForDiff,
    repoAbsolutePath,
    runSpecPath: runSpecContent ? runSpecPathRaw : undefined,
    specContent,
    stdout,
    stderr,
    message: result?.message,
    testTitle: result?.testCase?.title ?? job.testTitle ?? null,
  };
}

const SELF_HEAL_CONCURRENCY = Number(process.env.SELF_HEAL_CONCURRENCY ?? '2');
const SELF_HEAL_TIMEOUT_MS = Number(process.env.SELF_HEAL_TIMEOUT_MS ?? '30000');

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
        await triggerRerun(job.data.projectId, job.data.runId, context.testTitle ?? undefined, job.data.headed);
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
            `page.goto(${JSON.stringify(fixed)}, { waitUntil: "domcontentloaded", timeout: 15000 })`
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
        const gotoSimple = /page\.goto\(\s*([^)]+)\)/m;
        let patched = context.specContent;
        let updated = false;

        const replaceWith = (urlLiteral: string) =>
          `page.goto(${urlLiteral.trim()}, { waitUntil: "domcontentloaded", timeout: 15000 })`;

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

      // Rule: soften strict-mode locator errors by selecting first match
      if (containsStrictMode(context.message)) {
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

      if (job.data.totalFailed <= 1) {
        await triggerRerun(job.data.projectId, job.data.runId, context.testTitle ?? undefined, job.data.headed);
      } else {
        const remaining = await prisma.testHealingAttempt.count({
          where: { runId: job.data.runId, status: { not: HealingStatus.succeeded } },
        });
        if (remaining === 0) {
          await triggerRerun(job.data.projectId, job.data.runId, undefined, job.data.headed);
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
