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

const SELF_HEAL_CONCURRENCY = Number(process.env.SELF_HEAL_CONCURRENCY ?? '3');

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

      const healResult = await withTimeout(requestSpecHeal(promptPayload), 60_000);
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
