// apps/api/src/runner/ai-analysis.ts
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import OpenAI from "openai";
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import { prisma } from "../prisma.js";
import { executeAnalyzeAction, executeAssistAction, executeRepairAction } from "../ai/core/action-service.js";
import type { SelfHealPayload } from "./queue.js";
import { DEFAULT_FRAMEWORK_ID } from "@testmind/core/framework";
import { REPORT_ROOT } from "../lib/storageRoots.js";
import { decryptSecret } from "../lib/crypto.js";

export type AnalysisResult = {
  summary: string;
  cause: string;
  suggestion: string;
  model: string;
};

export type FixPlanAction =
  | {
      kind: "replace_block";
      file: string;
      matchStart: string;
      matchEnd: string;
      replacement: string;
      reason: string;
    }
  | {
      kind: "replace_literal";
      file: string;
      find: string;
      replace: string;
      reason: string;
    };

export type FixPlan = {
  version: 1;
  runId: string;
  specPath?: string;
  fingerprint?: string;
  actions: FixPlanAction[];
};

export type AnalysisDocument = AnalysisResult & {
  actionId?: string;
  status?: "allowed" | "blocked";
  allowed?: boolean;
  reasons?: string[];
  frameworkId?: string | null;
  targetScope?: "run" | "spec" | "testcase";
  rerunIntent?: "ai-rerun" | null;
  snapshot?: {
    framework?: string | null;
    specPath: string;
    testTitle?: string | null;
    failureMessage?: string | null;
    stdoutSnippet: string;
    stderrSnippet: string;
    specSnippet: string;
  };
  plan?: FixPlan;
};

const RUNNER_LOG_ROOTS = [
  REPORT_ROOT,
  path.join(process.cwd(), "runner-logs"),
  path.join(process.cwd(), "apps", "api", "runner-logs"),
];
const OPENAI_SECRET_KEYS = ["OPENAI_API_KEY", "OPEN_API_KEY"] as const;

const flagEnabled = () => {
  loadBackendEnv();
  const v = (process.env.ENABLE_AI_ANALYSIS || "").toLowerCase();
  return ["1", "true", "yes", "on"].includes(v) && !!(process.env.OPENAI_API_KEY || process.env.OPEN_API_KEY);
};

function getModel() {
  loadBackendEnv();
  return process.env.ANALYSIS_MODEL || "gpt-4o-mini";
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function loadBackendEnv() {
  if (process.env.OPENAI_API_KEY || process.env.OPEN_API_KEY) return;
  const candidates = [
    path.resolve(__dirname, "..", "..", ".env"),
    path.resolve(__dirname, "..", "..", "..", ".env"),
  ];
  for (const candidate of candidates) {
    if (!fsSync.existsSync(candidate)) continue;
    loadEnv({ path: candidate });
    if (process.env.OPENAI_API_KEY || process.env.OPEN_API_KEY) return;
  }
}

function resolveEnvOpenAiKey() {
  return process.env.OPENAI_API_KEY ?? process.env.OPEN_API_KEY ?? "";
}

async function resolveAnalyzeOpenAiKey(projectId?: string) {
  loadBackendEnv();
  if (!projectId) return resolveEnvOpenAiKey();
  const secrets = await prisma.projectSecret.findMany({
    where: { projectId },
    select: { key: true, value: true },
  });
  const secret = secrets.find((s) => OPENAI_SECRET_KEYS.includes(s.key as any));
  if (!secret) return resolveEnvOpenAiKey();
  try {
    return decryptSecret(secret.value);
  } catch {
    throw new Error("Failed to decrypt OPENAI_API_KEY secret. Please re-save it.");
  }
}

function normalizePath(value?: string | null) {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/^\.?\/+/, "")
    .replace(/^\/+/, "");
}

function selectTargetByFileOrGrep(
  rows: Array<{
    id: string;
    testCaseId: string;
    message: string | null;
    testCase: { key: string; title: string };
  }>,
  file?: string,
  grep?: string
) {
  const normalizedFile = normalizePath(file);
  let grepRegex: RegExp | null = null;
  if (grep) {
    try {
      grepRegex = new RegExp(grep, "i");
    } catch {
      grepRegex = null;
    }
  }
  const byFile = normalizedFile
    ? rows.find((row) => {
        const keyFile = normalizePath((row.testCase?.key ?? "").split("#")[0] || "");
        return (
          keyFile === normalizedFile ||
          keyFile.endsWith(`/${normalizedFile}`) ||
          normalizedFile.endsWith(`/${keyFile}`)
        );
      })
    : null;
  if (byFile && grepRegex?.test(rowTitle(byFile))) return byFile;
  if (byFile) return byFile;
  if (grepRegex) {
    const byGrep = rows.find((row) => grepRegex!.test(rowTitle(row)));
    if (byGrep) return byGrep;
  }
  return rows[0] ?? null;
}

function rowTitle(row: { testCase: { title: string } }) {
  return String(row.testCase?.title ?? "");
}

type PrepareRunActionOptions = {
  runId: string;
  file?: string;
  grep?: string;
  baseUrl?: string;
  adapterId?: string;
};

async function buildRunActionPayload(opts: PrepareRunActionOptions): Promise<SelfHealPayload | null> {
  const [run, failedResults] = await Promise.all([
    prisma.testRun.findUnique({
      where: { id: opts.runId },
      select: { id: true, projectId: true, paramsJson: true },
    }),
    prisma.testResult.findMany({
      where: { runId: opts.runId, status: "failed" as any },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        testCaseId: true,
        message: true,
        testCase: { select: { key: true, title: true } },
      },
    }),
  ]);

  if (!run || failedResults.length === 0) return null;
  const target = selectTargetByFileOrGrep(failedResults, opts.file, opts.grep);
  if (!target) return null;

  const params = (run.paramsJson as Record<string, unknown> | null) ?? null;
  const adapterId =
    opts.adapterId ??
    (typeof params?.adapterId === "string" ? params.adapterId : DEFAULT_FRAMEWORK_ID);
  const headed = Boolean(params?.headful);
  return {
    runId: run.id,
    testResultId: target.id,
    testCaseId: target.testCaseId,
    attemptId: `analyze:${run.id}:${target.id}`,
    projectId: run.projectId,
    adapterId,
    totalFailed: failedResults.length,
    testTitle: target.testCase.title,
    headed,
    baseUrl: opts.baseUrl,
  };
}

export async function prepareRunAnalyzeAction(opts: PrepareRunActionOptions) {
  const payload = await buildRunActionPayload(opts);
  if (!payload) return null;
  return executeAnalyzeAction({ job: payload });
}

export async function prepareRunAssistAction(opts: PrepareRunActionOptions) {
  const payload = await buildRunActionPayload(opts);
  if (!payload) return null;
  return executeAssistAction({ job: payload });
}

export async function prepareRunRepairSelection(opts: PrepareRunActionOptions) {
  const payload = await buildRunActionPayload(opts);
  if (!payload) return null;
  return executeRepairAction({ job: payload });
}

type PrepareRunRepairActionOptions = {
  runId: string;
  testResultId: string;
  testCaseId: string;
  testTitle?: string;
  baseUrl?: string;
  adapterId?: string;
};

async function buildTargetedRunActionPayload(
  opts: PrepareRunRepairActionOptions
): Promise<SelfHealPayload | null> {
  const [run, failedResults] = await Promise.all([
    prisma.testRun.findUnique({
      where: { id: opts.runId },
      select: { id: true, projectId: true, paramsJson: true },
    }),
    prisma.testResult.findMany({
      where: { runId: opts.runId, status: "failed" as any },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        testCaseId: true,
        message: true,
        testCase: { select: { key: true, title: true } },
      },
    }),
  ]);

  if (!run || failedResults.length === 0) return null;
  const target = failedResults.find(
    (row) => row.id === opts.testResultId && row.testCaseId === opts.testCaseId
  );
  if (!target) return null;

  const params = (run.paramsJson as Record<string, unknown> | null) ?? null;
  const adapterId =
    opts.adapterId ??
    (typeof params?.adapterId === "string" ? params.adapterId : DEFAULT_FRAMEWORK_ID);
  const headed = Boolean(params?.headful);
  return {
    runId: run.id,
    testResultId: target.id,
    testCaseId: target.testCaseId,
    attemptId: `repair:${run.id}:${target.id}`,
    projectId: run.projectId,
    adapterId,
    totalFailed: failedResults.length,
    testTitle: opts.testTitle ?? target.testCase.title,
    headed,
    baseUrl: opts.baseUrl,
  };
}

export async function prepareRunRepairAction(opts: PrepareRunRepairActionOptions) {
  const payload = await buildTargetedRunActionPayload(opts);
  if (!payload) return null;
  return executeRepairAction({ job: payload });
}

function buildActionDocBase(action: Awaited<ReturnType<typeof prepareRunAnalyzeAction>>): Partial<AnalysisDocument> {
  return action
    ? {
        actionId: action.actionId,
        status: action.status,
        allowed: action.allowed,
        reasons: action.reasons,
        frameworkId: action.frameworkId ?? null,
        targetScope: action.targetScope,
        rerunIntent: action.rerunIntent ?? null,
        snapshot: action.snapshot,
      }
    : {};
}

async function readFirstSnippet(paths: string[], limit: number) {
  for (const candidate of paths) {
    try {
      const raw = await fs.readFile(candidate, "utf8");
      return raw.slice(0, limit);
    } catch {
      // try next candidate
    }
  }
  return "";
}

export async function generateAnalyzeDocument(opts: {
  runId: string;
  grep?: string;
  file?: string;
  baseUrl?: string;
  stderr?: string;
  stdout?: string;
  reportPath?: string;
  outDir?: string;
  action?: Awaited<ReturnType<typeof prepareRunAnalyzeAction>>;
  requireEnabledFlag?: boolean;
}) {
  const action =
    opts.action ??
    (await prepareRunAnalyzeAction({
      runId: opts.runId,
      file: opts.file,
      grep: opts.grep,
      baseUrl: opts.baseUrl,
    }));
  const actionDocBase = buildActionDocBase(action);
  const projectId = action?.context.scope.projectId;
  const runLogRoot =
    RUNNER_LOG_ROOTS.find((root) => fsSync.existsSync(path.join(root, opts.runId))) ??
    RUNNER_LOG_ROOTS[0];
  const reportPath =
    opts.reportPath ??
    path.join(runLogRoot, opts.runId, "report.json");
  const pageSignalsCandidates = [
    opts.outDir ? path.join(opts.outDir, "page-signals.json") : null,
    path.join(runLogRoot, opts.runId, "page-signals.json"),
  ].filter((value): value is string => Boolean(value));
  const stdoutText = opts.stdout ?? action?.snapshot.stdoutSnippet ?? "";
  const stderrText = opts.stderr ?? action?.snapshot.stderrSnippet ?? "";
  const enabled = (process.env.ENABLE_AI_ANALYSIS || "").toLowerCase();
  const enabledByConfig = ["1", "true", "yes", "on"].includes(enabled);
  const apiKey = await resolveAnalyzeOpenAiKey(projectId);

  if ((opts.requireEnabledFlag ?? true) && !enabledByConfig) {
    return {
      summary: "AI analysis disabled",
      cause: "ENABLE_AI_ANALYSIS is off",
      suggestion: "",
      model: getModel(),
      ...actionDocBase,
      status: "blocked",
      allowed: false,
      reasons: ["ai_analysis_disabled"],
    } satisfies AnalysisDocument;
  }

  if (!apiKey) {
    console.log("[ai-analysis] skipped (missing OPENAI_API_KEY)");
    return {
      summary: "AI analysis unavailable",
      cause: "Missing OPENAI_API_KEY",
      suggestion: "",
      model: getModel(),
      ...actionDocBase,
      status: "blocked",
      allowed: false,
      reasons: ["missing_openai_api_key"],
    } satisfies AnalysisDocument;
  }

  try {
    const openai = new OpenAI({ apiKey });
    const reportSnippet = await readFirstSnippet([reportPath], 4000);
    const pageSignals = await readFirstSnippet(pageSignalsCandidates, 8000);

    const prompt = `
You are a senior QA triage assistant. Summarize the likely cause and remediation for this failed run.
Return JSON with keys: summary, cause, suggestion.

Context:
- baseUrl: ${opts.baseUrl || "unknown"}
- grep: ${opts.grep || "none"}
- file: ${opts.file || "none"}
- framework: ${action?.frameworkId || "unknown"}
- targetScope: ${action?.targetScope || "run"}
- testTitle: ${action?.snapshot.testTitle || "unknown"}
- failureMessage: ${action?.snapshot.failureMessage || "n/a"}
- stderr: ${stderrText.slice(0, 4000) || "n/a"}
- stdout: ${stdoutText.slice(0, 4000) || "n/a"}
- report.json snippet: ${reportSnippet || "n/a"}
- page-signals.json snippet: ${pageSignals || "n/a"}
- spec snippet: ${action?.snapshot.specSnippet || "n/a"}
`;

    const completion = await openai.chat.completions.create({
      model: getModel(),
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "You are a concise QA triage assistant. Respond in JSON." },
        { role: "user", content: prompt },
      ],
    });

    const content = completion.choices?.[0]?.message?.content ?? "";
    let parsed: AnalysisResult | null = null;
    try {
      const maybe = JSON.parse(content);
      if (maybe && typeof maybe === "object") {
        parsed = {
          summary: String(maybe.summary || "").slice(0, 500),
          cause: String(maybe.cause || "").slice(0, 500),
          suggestion: String(maybe.suggestion || "").slice(0, 500),
          model: getModel(),
        };
      }
    } catch {
      // fallback to text parsing
    }

    if (!parsed) {
      parsed = {
        summary: content.slice(0, 500) || "Unable to parse analysis",
        cause: "",
        suggestion: "",
        model: getModel(),
      };
    }

    return {
      ...parsed,
      ...actionDocBase,
      plan: buildFixPlan(
        {
          runId: opts.runId,
          outDir: opts.outDir ?? path.join(runLogRoot, opts.runId),
          stderr: stderrText,
          stdout: stdoutText,
          reportPath,
          grep: opts.grep,
          file: opts.file,
          baseUrl: opts.baseUrl,
        },
        parsed
      ),
    } satisfies AnalysisDocument;
  } catch (err: any) {
    return {
      summary: "AI analysis failed",
      cause: String(err?.message ?? err ?? "unknown error").slice(0, 500),
      suggestion: "",
      model: getModel(),
      ...actionDocBase,
      status: "blocked",
      allowed: false,
      reasons: [String(err?.message ?? err ?? "analysis_failed").slice(0, 500)],
    } satisfies AnalysisDocument;
  }
}

export async function analyzeFailure(opts: {
  runId: string;
  outDir: string;
  stderr?: string;
  stdout?: string;
  reportPath?: string;
  grep?: string;
  file?: string;
  baseUrl?: string;
  requireEnabledFlag?: boolean;
}) {
  const doc = await generateAnalyzeDocument(opts);
  if (!doc) return null;
  try {
    const analysisPath = path.join(opts.outDir, "analysis.json");
    await fs.writeFile(analysisPath, JSON.stringify(doc, null, 2), "utf8");
  } catch {
    // ignore write failures
  }
  return {
    summary: doc.summary,
    cause: doc.cause,
    suggestion: doc.suggestion,
    model: doc.model,
  };
}

function buildFixPlan(
  opts: Parameters<typeof analyzeFailure>[0],
  parsed: AnalysisResult
): FixPlan | undefined {
  const actions: FixPlanAction[] = [];
  const targetFile = opts.file;
  const failureText = `${opts.stderr || ""} ${opts.stdout || ""} ${parsed.cause || ""} ${parsed.suggestion || ""}`;

  if (
    failureText.includes("Invalid regular expression") ||
    failureText.includes("Nothing to repeat")
  ) {
    if (targetFile) {
      actions.push({
        kind: "replace_block",
        file: targetFile,
        matchStart: "async function navigateTo(page: Page, target: string) {",
        matchEnd: "async function sharedLogin(page: Page) {",
        replacement: [
          "async function navigateTo(page: Page, target: string) {",
          "  const url = new URL(target, BASE_URL);",
          "  await page.goto(url.toString(), { waitUntil: 'domcontentloaded' });",
          "  await expect(page).toHaveURL(url.toString());",
          "}",
          "",
          "async function sharedLogin(page: Page) {",
        ].join("\n"),
        reason: "Replace fragile regex nav helper with deterministic URL comparison",
      });
    }
  }

  if (actions.length === 0) return undefined;
  return {
    version: 1,
    runId: opts.runId,
    specPath: targetFile,
    fingerprint: failureText.slice(0, 200),
    actions,
  };
}
