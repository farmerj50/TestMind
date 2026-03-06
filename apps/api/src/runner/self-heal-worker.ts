import "dotenv/config";
import { Worker, Job } from 'bullmq';
import path from 'path';
import fs from 'fs/promises';
import { existsSync } from 'node:fs';
import { createTwoFilesPatch } from 'diff';
import ts from "typescript";
import { redis } from './redis.js';
import { prisma } from '../prisma.js';
import type { SelfHealPayload, RunPayload } from './queue.js';
import { enqueueRun } from './queue.js';
import { requestSpecHeal, requestSpecPatchOps, HealPrompt, type HealOperation } from './llm.js';
import { CURATED_ROOT } from "../testmind/curated-store.js";
import { GENERATED_ROOT, REPORT_ROOT } from "../lib/storageRoots.js";
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
  const generatedRoot = path.resolve(GENERATED_ROOT);
  if (normalizedSpecPath) {
    const strippedGenerated = normalizedSpecPath.replace(/^testmind-generated[\\/]/, "");
    candidates.add(path.join(generatedRoot, strippedGenerated));
  }
  candidates.add(path.join(generatedRoot, path.basename(fallback)));
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
  if (grep) params.requestedGrep = grep;
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
    await prisma.testRun.update({
      where: { id: rerun.id },
      data: {
        status: TestRunStatus.succeeded,
        finishedAt: new Date(),
        summary: "Self-heal patch applied; rerun skipped",
      },
    });
    return;
  }

  let resolvedSpec = targetSpec;
  if (targetSpec && !path.isAbsolute(targetSpec)) {
    const repoRoot = localRepoRoot ? path.resolve(localRepoRoot) : guessRepoRoot();
    const normalizedSpecPath =
      targetSpec.replace(/\\/g, "/").replace(/^\.?\/+/, "") || targetSpec;
    if (normalizedSpecPath.startsWith("testmind-generated/")) {
      const preferred = path.join(repoRoot, normalizedSpecPath);
      const generatedRoot = path.resolve(GENERATED_ROOT);
      const strippedGenerated = normalizedSpecPath.replace(/^testmind-generated[\\/]/, "");
      const generatedCandidate = path.join(generatedRoot, strippedGenerated);
      resolvedSpec =
        (await findExistingPath([preferred, generatedCandidate])) ??
        path.join(repoRoot, normalizedSpecPath);
    } else {
      const candidates = buildSpecCandidates(repoRoot, normalizedSpecPath, targetSpec);
      resolvedSpec = (await findExistingPath(candidates)) ?? path.join(repoRoot, normalizedSpecPath);
    }
  }
  if (resolvedSpec) {
    const repoRoot = localRepoRoot ? path.resolve(localRepoRoot) : guessRepoRoot();
    const resolvedPosix = toPosix(path.resolve(resolvedSpec));
    const repoRootPosix = toPosix(path.resolve(repoRoot));
    const generatedRootPosix = toPosix(path.resolve(GENERATED_ROOT));
    if (resolvedPosix.startsWith(`${generatedRootPosix}/`)) {
      const rel = resolvedPosix.slice(generatedRootPosix.length + 1);
      resolvedSpec = `testmind-generated/${rel}`;
    } else if (resolvedPosix.startsWith(`${repoRootPosix}/`)) {
      resolvedSpec = resolvedPosix.slice(repoRootPosix.length + 1);
    }
  }

  const payload: RunPayload = {
    projectId,
    localRepoRoot,
    file: resolvedSpec,
  };
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
    await prisma.testRun.update({
      where: { id: rerun.id },
      data: {
        status: TestRunStatus.failed,
        finishedAt: new Date(),
        error: String(err),
      },
    });
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
  const logRoots = [
    REPORT_ROOT,
    path.join(process.cwd(), "runner-logs"),
    path.join(process.cwd(), "apps", "api", "runner-logs"),
  ];
  const runLogDir =
    logRoots.find((root) => existsSync(path.join(root, job.runId))) ??
    path.join(REPORT_ROOT, job.runId);
  const stdoutPath = path.join(runLogDir, 'stdout.txt');
  const stderrPath = path.join(runLogDir, 'stderr.txt');

  const [stdout, stderr, result, fallbackCase] = await Promise.all([
    fs.readFile(stdoutPath, 'utf8').catch(() => ''),
    fs.readFile(stderrPath, 'utf8').catch(() => ''),
    prisma.testResult.findUnique({
      where: { id: job.testResultId },
      select: { message: true, testCase: { select: { key: true, title: true } } },
    }),
    prisma.testCase.findUnique({
      where: { id: job.testCaseId },
      select: { key: true, title: true },
    }),
  ]);

  const key = result?.testCase?.key ?? fallbackCase?.key ?? 'unknown-spec';
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
  const rawTitle = result?.testCase?.title ?? fallbackCase?.title ?? job.testTitle ?? null;
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
const parseBoolEnv = (value: string | undefined, fallback: boolean) => {
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  return fallback;
};
const parseIntEnv = (value: string | undefined, fallback: number, min = 1, max = Number.MAX_SAFE_INTEGER) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
};
const SELF_HEAL_HEAL_ONLY = parseBoolEnv(process.env.SELF_HEAL_HEAL_ONLY, false);
const SELF_HEAL_STRUCTURED_PATCH = parseBoolEnv(process.env.SELF_HEAL_STRUCTURED_PATCH, true);
const SELF_HEAL_ALLOW_FULL_REWRITE_FALLBACK = parseBoolEnv(process.env.SELF_HEAL_ALLOW_FULL_REWRITE_FALLBACK, true);
const SELF_HEAL_STRUCTURED_TIMEOUT_MS = parseIntEnv(
  process.env.SELF_HEAL_STRUCTURED_TIMEOUT_MS,
  Math.min(45000, SELF_HEAL_TIMEOUT_MS),
  5000,
  SELF_HEAL_TIMEOUT_MS
);
const SELF_HEAL_MAX_PATCH_OPS = parseIntEnv(process.env.SELF_HEAL_MAX_PATCH_OPS, 8, 1, 50);
const SELF_HEAL_MAX_PATCH_TEXT = parseIntEnv(process.env.SELF_HEAL_MAX_PATCH_TEXT, 8000, 200, 20000);
const INFRA_ERROR_PATTERNS = [
  /net::/i,
  /disconnected/i,
  /chrome.*not reachable/i,
  /connection refused/i,
  /socket hang up/i,
];
const HEAL_MAX_CHANGED_LINES = Number(process.env.SELF_HEAL_MAX_CHANGED_LINES ?? "220");
const HEAL_MAX_BYTES_DELTA = Number(process.env.SELF_HEAL_MAX_BYTES_DELTA ?? "28000");
const FORBIDDEN_IMPORT_MODULES = [
  "child_process",
  "node:child_process",
  "fs",
  "node:fs",
  "net",
  "node:net",
  "http",
  "node:http",
  "https",
  "node:https",
  "tls",
  "node:tls",
  "dgram",
  "node:dgram",
  "worker_threads",
  "node:worker_threads",
];
const FORBIDDEN_RUNTIME_PATTERNS: RegExp[] = [
  /\beval\s*\(/i,
  /\bnew\s+Function\s*\(/i,
  /\bfetch\s*\(/i,
  /\bXMLHttpRequest\b/i,
];

type HealFixType = "fallback" | "rule_fixed" | "llm_patch_fixed" | "llm_rejected_policy" | "none";
const toJson = <T>(value: T): any => JSON.parse(JSON.stringify(value));

console.log("[self-heal] config", {
  structuredPatch: SELF_HEAL_STRUCTURED_PATCH,
  allowFullRewriteFallback: SELF_HEAL_ALLOW_FULL_REWRITE_FALLBACK,
  structuredTimeoutMs: SELF_HEAL_STRUCTURED_TIMEOUT_MS,
  totalTimeoutMs: SELF_HEAL_TIMEOUT_MS,
  maxPatchOps: SELF_HEAL_MAX_PATCH_OPS,
  maxPatchText: SELF_HEAL_MAX_PATCH_TEXT,
  healOnly: SELF_HEAL_HEAL_ONLY,
});

function parseImportModules(spec: string): string[] {
  const out: string[] = [];
  const importRe = /^\s*import[\s\S]*?from\s+["']([^"']+)["'];?\s*$/gm;
  const sideEffectImportRe = /^\s*import\s+["']([^"']+)["'];?\s*$/gm;
  let match: RegExpExecArray | null = null;
  while ((match = importRe.exec(spec))) out.push(match[1]);
  while ((match = sideEffectImportRe.exec(spec))) out.push(match[1]);
  return out;
}

function extractInlineTestTitles(spec: string): string[] {
  const titles: string[] = [];
  const testRe = /\btest(?:\.(?:only|skip|fixme))?\(\s*(["'`])((?:\\.|(?!\1)[\s\S])*)\1/gm;
  let match: RegExpExecArray | null = null;
  while ((match = testRe.exec(spec))) {
    titles.push(match[2]);
  }
  return titles.sort();
}

function changedLineCount(before: string, after: string): number {
  const patch = createTwoFilesPatch("before.ts", "after.ts", before, after);
  return patch
    .split("\n")
    .filter((line) => (line.startsWith("+") || line.startsWith("-")) && !line.startsWith("+++") && !line.startsWith("---"))
    .length;
}

function redactSecrets(value: string): string {
  if (!value) return value;
  const redactions: Array<[RegExp, string]> = [
    [/\b(ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "[REDACTED_GITHUB_TOKEN]"],
    [/\b(sk-[A-Za-z0-9]{20,})\b/g, "[REDACTED_OPENAI_KEY]"],
    [/\b(Authorization\s*:\s*Bearer\s+)[^\s"']+/gi, "$1[REDACTED]"],
    [/\b(cookie\s*:\s*)[^;\n]+/gi, "$1[REDACTED]"],
    [/\b(x-api-key\s*:\s*)[^\s"']+/gi, "$1[REDACTED]"],
    [/\b(password|passwd|token|secret|api[_-]?key)\s*[:=]\s*([^\s,;]+)/gi, "$1=[REDACTED]"],
  ];
  return redactions.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), value);
}

function validatePatchedSpec(before: string, after: string): string | null {
  if (!after.trim()) return "Patched spec is empty.";

  const syntax = ts.transpileModule(after, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
    },
    reportDiagnostics: true,
    fileName: "patched.spec.ts",
  });
  if (syntax.diagnostics && syntax.diagnostics.length > 0) {
    const first = syntax.diagnostics[0];
    return `Patched spec has TypeScript syntax errors: ${ts.flattenDiagnosticMessageText(first.messageText, "\n")}`;
  }
  const parsed = ts.createSourceFile("patched.spec.ts", after, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

  const byteDelta = Math.abs(Buffer.byteLength(after, "utf8") - Buffer.byteLength(before, "utf8"));
  if (byteDelta > HEAL_MAX_BYTES_DELTA) {
    return `Patched spec changed too much content (${byteDelta} bytes).`;
  }

  const changedLines = changedLineCount(before, after);
  if (changedLines > HEAL_MAX_CHANGED_LINES) {
    return `Patched spec changed too many lines (${changedLines}).`;
  }

  const beforeTitles = extractInlineTestTitles(before);
  const afterTitles = extractInlineTestTitles(after);
  if (beforeTitles.join("\n") !== afterTitles.join("\n")) {
    return "Patched spec changed test titles, which is not allowed.";
  }

  const beforeImports = new Set(parseImportModules(before));
  const afterImports = new Set(parseImportModules(after));
  for (const moduleName of afterImports) {
    if (FORBIDDEN_IMPORT_MODULES.includes(moduleName)) {
      return `Patched spec imports forbidden module: ${moduleName}`;
    }
    if (!beforeImports.has(moduleName) && moduleName !== "@playwright/test") {
      return `Patched spec introduced new import module: ${moduleName}`;
    }
  }

  for (const pattern of FORBIDDEN_RUNTIME_PATTERNS) {
    if (pattern.test(after)) {
      return `Patched spec contains forbidden runtime pattern: ${pattern}`;
    }
  }

  let astError: string | null = null;
  const visit = (node: ts.Node) => {
    if (astError) return;
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        astError = "Patched spec uses dynamic import(), which is not allowed.";
        return;
      }
      if (ts.isIdentifier(node.expression)) {
        if (node.expression.text === "eval") {
          astError = "Patched spec uses eval(), which is not allowed.";
          return;
        }
        if (node.expression.text === "fetch") {
          astError = "Patched spec uses fetch(), which is not allowed.";
          return;
        }
        if (node.expression.text === "require") {
          const firstArg = node.arguments[0];
          if (firstArg && ts.isStringLiteralLike(firstArg)) {
            const moduleName = firstArg.text;
            if (FORBIDDEN_IMPORT_MODULES.includes(moduleName)) {
              astError = `Patched spec requires forbidden module: ${moduleName}`;
              return;
            }
          }
        }
      }
    }
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Function") {
      astError = "Patched spec uses new Function(), which is not allowed.";
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  if (astError) return astError;

  return null;
}

function validateHealOperations(operations: HealOperation[]): string | null {
  if (!Array.isArray(operations) || !operations.length) {
    return "Patch operations are empty.";
  }
  if (operations.length > SELF_HEAL_MAX_PATCH_OPS) {
    return `Too many patch operations (${operations.length}).`;
  }
  for (const [index, op] of operations.entries()) {
    if (!op || typeof op !== "object" || typeof (op as any).type !== "string") {
      return `Invalid patch operation at index ${index}.`;
    }
    if (op.type === "replace_literal") {
      if (!op.find || !op.replace) return `replace_literal requires find/replace at index ${index}.`;
      if (op.find.length > SELF_HEAL_MAX_PATCH_TEXT || op.replace.length > SELF_HEAL_MAX_PATCH_TEXT) {
        return `replace_literal payload too large at index ${index}.`;
      }
      continue;
    }
    if (op.type === "insert_after_literal") {
      if (!op.find || !op.insert) return `insert_after_literal requires find/insert at index ${index}.`;
      if (op.find.length > SELF_HEAL_MAX_PATCH_TEXT || op.insert.length > SELF_HEAL_MAX_PATCH_TEXT) {
        return `insert_after_literal payload too large at index ${index}.`;
      }
      continue;
    }
    if (op.type === "replace_regex_once") {
      if (!op.pattern || !op.replace) return `replace_regex_once requires pattern/replace at index ${index}.`;
      if (op.pattern.length > SELF_HEAL_MAX_PATCH_TEXT || op.replace.length > SELF_HEAL_MAX_PATCH_TEXT) {
        return `replace_regex_once payload too large at index ${index}.`;
      }
      const flags = op.flags ?? "";
      if (!/^[dgimsuvy]*$/i.test(flags)) {
        return `replace_regex_once has invalid flags at index ${index}.`;
      }
      continue;
    }
    return `Unsupported operation type '${(op as any).type}' at index ${index}.`;
  }
  return null;
}

function applyHealOperations(specContent: string, operations: HealOperation[]): string {
  let next = specContent;
  for (const op of operations) {
    if (op.type === "replace_literal") {
      if (!next.includes(op.find)) throw new Error(`replace_literal target not found: ${op.find.slice(0, 80)}`);
      next = next.replace(op.find, op.replace);
      continue;
    }
    if (op.type === "insert_after_literal") {
      const idx = next.indexOf(op.find);
      if (idx === -1) throw new Error(`insert_after_literal target not found: ${op.find.slice(0, 80)}`);
      const offset = idx + op.find.length;
      next = `${next.slice(0, offset)}${op.insert}${next.slice(offset)}`;
      continue;
    }
    if (op.type === "replace_regex_once") {
      const re = new RegExp(op.pattern, op.flags ?? "");
      if (!re.test(next)) throw new Error(`replace_regex_once pattern not found: ${op.pattern}`);
      next = next.replace(re, op.replace);
      continue;
    }
  }
  return next;
}

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

      const writeAndRecordSuccess = async (
        patched: string,
        summary: string,
        note: string,
        fixType: HealFixType = "rule_fixed",
        fixDetails?: Record<string, unknown>
      ) => {
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
            response: {
              raw: note,
              fixType,
              fixDetails: toJson(fixDetails ?? { note }),
            },
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
        await writeAndRecordSuccess(
          navPatchedSpec,
          "Auto-fixed navigation URL",
          "rule-based url fix",
          "rule_fixed",
          { rule: "url-fix" }
        );
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
          await writeAndRecordSuccess(
            patched,
            "Auto-increased navigation timeout",
            "rule-based nav-timeout",
            "rule_fixed",
            { rule: "nav-timeout" }
          );
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
              "rule-based strict-mode href",
              "rule_fixed",
              { rule: "strict-mode-href", href }
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
            "rule-based strict-mode",
            "rule_fixed",
            { rule: "strict-mode-first" }
          );
          return;
        }
      }

      const promptPayload: HealPrompt = {
        projectId: job.data.projectId,
        specPath: context.repoRelativePath,
        failureMessage: redactSecrets(context.message ?? ""),
        stdout: redactSecrets((context.stdout || '').slice(0, 4000)),
        stderr: redactSecrets((context.stderr || '').slice(0, 4000)),
        specContent: context.specContent,
      };

      console.log(
        `[self-heal] starting attempt ${attemptId} for run ${job.data.runId} (testResult=${job.data.testResultId})`
      );

      let healedSummary = "";
      let healedRaw = "";
      let patchedSpec = "";
      let healMode: "structured" | "full-rewrite" = "full-rewrite";
      let structuredFallbackReason: string | null = null;
      let structuredOperations: HealOperation[] | null = null;
      const healStartedAt = Date.now();
      const remainingBudgetMs = () =>
        Math.max(0, SELF_HEAL_TIMEOUT_MS - (Date.now() - healStartedAt));

      if (SELF_HEAL_STRUCTURED_PATCH) {
        try {
          const structuredBudget = Math.max(5000, Math.min(SELF_HEAL_STRUCTURED_TIMEOUT_MS, remainingBudgetMs()));
          const patchResult = await withTimeout(requestSpecPatchOps(promptPayload), structuredBudget);
          const opValidation = validateHealOperations(patchResult.operations);
          if (opValidation) {
            throw new Error(`Structured patch validation failed: ${opValidation}`);
          }
          patchedSpec = applyHealOperations(context.specContent, patchResult.operations);
          healedSummary = patchResult.summary;
          healedRaw = patchResult.raw;
          structuredOperations = patchResult.operations;
          healMode = "structured";
        } catch (structuredErr) {
          structuredFallbackReason =
            structuredErr instanceof Error ? structuredErr.message : String(structuredErr);
          if (!SELF_HEAL_ALLOW_FULL_REWRITE_FALLBACK) {
            throw structuredErr;
          }
          console.warn(
            `[self-heal] structured patch failed for attempt ${attemptId}; falling back to full rewrite`,
            structuredErr
          );
        }
      }

      if (!patchedSpec) {
        const budget = remainingBudgetMs();
        if (budget <= 0) {
          throw new Error(`self-heal timeout after ${SELF_HEAL_TIMEOUT_MS}ms`);
        }
        const healResult = await withTimeout(requestSpecHeal(promptPayload), budget);
        patchedSpec = healResult.updatedSpec;
        healedSummary = healResult.summary;
        healedRaw = healResult.raw;
      }

      const validationError = validatePatchedSpec(context.specContent, patchedSpec);
      if (validationError) {
        throw new Error(`Self-heal patch validation failed: ${validationError}`);
      }
      await fs.mkdir(path.dirname(context.repoAbsolutePath), { recursive: true });
      await fs.writeFile(context.repoAbsolutePath, patchedSpec, 'utf8');

      const diff = createTwoFilesPatch(
        context.repoRelativePath,
        context.repoRelativePath,
        context.specContent,
        patchedSpec
      );

      await prisma.testHealingAttempt.update({
        where: { id: attemptId },
        data: {
          status: HealingStatus.succeeded,
          summary: healedSummary,
          diff,
          prompt: promptPayload,
          response: {
            raw: healedRaw,
            mode: healMode,
            structuredFallbackReason,
            operationCount: structuredOperations?.length ?? null,
            operationTypes: structuredOperations?.map((op) => op.type) ?? [],
            fixType: "llm_patch_fixed" as HealFixType,
            fixDetails: toJson({
              mode: healMode,
              operationCount: structuredOperations?.length ?? 0,
              operationTypes: structuredOperations?.map((op) => op.type) ?? [],
              structuredFallbackReason,
            }),
          },
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
      const msg = err?.message ?? String(err);
      const rejectedByPolicy =
        /validation failed|forbidden|payload too large|introduced new import|dynamic import|new Function|eval|patch operations/i.test(
          msg
        );
      await prisma.testHealingAttempt.update({
        where: { id: attemptId },
        data: {
          status: HealingStatus.failed,
          error: msg,
          response: {
            fixType: (rejectedByPolicy ? "llm_rejected_policy" : "none") as HealFixType,
            fixDetails: toJson({
              reason: msg,
              rejectedByPolicy,
            }),
          },
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
