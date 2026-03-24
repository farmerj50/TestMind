import { createTwoFilesPatch } from "diff";
import ts from "typescript";
import { DEFAULT_FRAMEWORK_ID } from "@testmind/core/framework";
import type { HealOperation, HealPrompt } from "../../runner/llm.js";
import type { AiExecutionContext } from "./types.js";

const INFRA_ERROR_PATTERNS = [
  /net::/i,
  /disconnected/i,
  /chrome.*not reachable/i,
  /connection refused/i,
  /socket hang up/i,
] as const;

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
] as const;

const FORBIDDEN_RUNTIME_PATTERNS: RegExp[] = [
  /\beval\s*\(/i,
  /\bnew\s+Function\s*\(/i,
  /\bfetch\s*\(/i,
  /\bXMLHttpRequest\b/i,
] as const;

export type HealFixType =
  | "fallback"
  | "rule_fixed"
  | "llm_patch_fixed"
  | "llm_rejected_policy"
  | "none";

export type RepairFailureClass =
  | "missing_text_assertion"
  | "strict_mode_locator"
  | "navigation_timeout"
  | "pathname_mismatch"
  | "identity_mismatch"
  | "url_assertion"
  | "locator_resolution_failed"
  | "missing_locator_comment"
  | "login_selector_timeout"
  | "css_selector_parse_error"
  | "role_locator_missing"
  | "unknown";

type PatchLimits = {
  maxChangedLines: number;
  maxBytesDelta: number;
};

type PatchOperationLimits = {
  maxOps: number;
  maxText: number;
};

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

export function containsNavTimeout(msg?: string | null) {
  if (!msg) return false;
  const lower = msg.toLowerCase();
  return lower.includes("page.goto") && lower.includes("timeout");
}

export function containsStrictMode(msg?: string | null) {
  if (!msg) return false;
  const lower = msg.toLowerCase();
  return (
    lower.includes("strict mode") ||
    lower.includes("resolved to") ||
    lower.includes("matches 2 elements")
  );
}

export function isInfraError(msg?: string | null) {
  if (!msg) return false;
  return INFRA_ERROR_PATTERNS.some((pattern) => pattern.test(msg));
}

export function classifyFailureContext(input: {
  message?: string | null;
  specContent?: string;
  stdout?: string;
  stderr?: string;
  testTitle?: string | null;
}): RepairFailureClass[] {
  const message = `${input.message || ""}\n${input.stderr || ""}\n${input.stdout || ""}`;
  const classes = new Set<RepairFailureClass>();
  if (containsNavTimeout(message)) classes.add("navigation_timeout");
  if (/Expected pathname (?:to start with )?.* but saw /i.test(message)) {
    classes.add("pathname_mismatch");
  }
  if (/IDENTITY_MISMATCH|Identity mismatch before locator resolution/i.test(message)) {
    classes.add("identity_mismatch");
  }
  if (containsStrictMode(message)) classes.add("strict_mode_locator");
  if (/LOCATOR_RESOLUTION_FAILED/i.test(message)) {
    classes.add("locator_resolution_failed");
  }
  if (/Unexpected token .*parsing css selector/i.test(message)) classes.add("css_selector_parse_error");
  if (/toHaveURL|waiting for navigation|url mismatch/i.test(message)) classes.add("url_assertion");
  if (/getByText\(/i.test(message) && /(not found|not visible|Timeout)/i.test(message)) {
    classes.add("missing_text_assertion");
  }
  if (/getByRole\(/i.test(message) && /(not found|not visible|Timeout)/i.test(message)) {
    classes.add("role_locator_missing");
  }
  if (
    /usernameSelector|passwordSelector|sharedLogin|Email Address|input\[type="email"\]|input\[name="email"\]/i.test(
      `${message}\n${input.specContent || ""}`
    )
  ) {
    classes.add("login_selector_timeout");
  }
  if (/\/\/ Missing locator .* add it to shared locators and rerun generation\./i.test(input.specContent || "")) {
    classes.add("missing_locator_comment");
  }
  if (classes.size === 0) classes.add("unknown");
  return [...classes];
}

export function redactSecrets(value: string): string {
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

export function stripMarkdownCodeFence(content: string): string {
  const fenced = content.match(/^\s*```[A-Za-z0-9_-]*\s*\r?\n([\s\S]*?)\r?\n```\s*$/);
  if (!fenced) return content;
  return `${fenced[1].trimEnd()}\n`;
}

function validatePatchedFeature(after: string): string | null {
  if (after.includes("```")) return "Patched feature contains Markdown code fences.";
  const lines = after.split(/\r?\n/);
  let sawFeature = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (!sawFeature) {
      if (trimmed.startsWith("@")) continue;
      if (!trimmed.startsWith("Feature:")) {
        return `Patched feature must start with Feature:, got '${trimmed.slice(0, 60)}'.`;
      }
      sawFeature = true;
      continue;
    }
    if (
      trimmed.startsWith("@") ||
      trimmed.startsWith("Rule:") ||
      trimmed.startsWith("Background:") ||
      trimmed.startsWith("Scenario:") ||
      trimmed.startsWith("Scenario Outline:") ||
      trimmed.startsWith("Examples:") ||
      trimmed.startsWith("As a ") ||
      trimmed.startsWith("I want to ") ||
      trimmed.startsWith("So that ")
    ) {
      continue;
    }
    if (/^(Given|When|Then|And|But)\s+/.test(trimmed)) {
      if (/\bwithin\s+\d+ms\b/i.test(trimmed)) {
        return `Patched feature added unsupported timeout syntax: '${trimmed}'.`;
      }
      const supportedPrefixes = [
        "I navigate to ",
        "I click ",
        "I fill ",
        "I upload ",
        "I should see text ",
        "I should see element ",
      ];
      const remainder = trimmed.replace(/^(Given|When|Then|And|But)\s+/, "");
      if (!supportedPrefixes.some((prefix) => remainder.startsWith(prefix))) {
        return `Patched feature added unsupported step text: '${trimmed}'.`;
      }
      continue;
    }
    if (trimmed === '"""' || trimmed.startsWith("|")) continue;
    return `Patched feature contains unsupported Gherkin line: '${trimmed}'.`;
  }

  if (!sawFeature) return "Patched feature is missing a Feature: header.";
  return null;
}

export function validatePatchedSpec(
  before: string,
  after: string,
  adapterId: string = DEFAULT_FRAMEWORK_ID,
  limits: PatchLimits
): string | null {
  const cleaned = stripMarkdownCodeFence(after);
  if (!cleaned.trim()) return "Patched spec is empty.";

  const byteDelta = Math.abs(Buffer.byteLength(cleaned, "utf8") - Buffer.byteLength(before, "utf8"));
  if (byteDelta > limits.maxBytesDelta) {
    return `Patched spec changed too much content (${byteDelta} bytes).`;
  }

  const changedLines = changedLineCount(before, cleaned);
  if (changedLines > limits.maxChangedLines) {
    return `Patched spec changed too many lines (${changedLines}).`;
  }

  if (adapterId === "cucumber-js") {
    return validatePatchedFeature(cleaned);
  }

  const syntax = ts.transpileModule(cleaned, {
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
  const parsed = ts.createSourceFile("patched.spec.ts", cleaned, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

  const beforeTitles = extractInlineTestTitles(before);
  const afterTitles = extractInlineTestTitles(cleaned);
  if (beforeTitles.join("\n") !== afterTitles.join("\n")) {
    return "Patched spec changed test titles, which is not allowed.";
  }

  const beforeImports = new Set(parseImportModules(before));
  const afterImports = new Set(parseImportModules(cleaned));
  for (const moduleName of afterImports) {
    if (FORBIDDEN_IMPORT_MODULES.includes(moduleName as (typeof FORBIDDEN_IMPORT_MODULES)[number])) {
      return `Patched spec imports forbidden module: ${moduleName}`;
    }
    if (!beforeImports.has(moduleName) && moduleName !== "@playwright/test") {
      return `Patched spec introduced new import module: ${moduleName}`;
    }
  }

  for (const pattern of FORBIDDEN_RUNTIME_PATTERNS) {
    if (pattern.test(cleaned)) {
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
            if (FORBIDDEN_IMPORT_MODULES.includes(moduleName as (typeof FORBIDDEN_IMPORT_MODULES)[number])) {
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

export function validateHealOperations(
  operations: HealOperation[],
  limits: PatchOperationLimits
): string | null {
  if (!Array.isArray(operations) || !operations.length) {
    return "Patch operations are empty.";
  }
  if (operations.length > limits.maxOps) {
    return `Too many patch operations (${operations.length}).`;
  }
  for (const [index, op] of operations.entries()) {
    if (!op || typeof op !== "object" || typeof (op as any).type !== "string") {
      return `Invalid patch operation at index ${index}.`;
    }
    if (op.type === "replace_literal") {
      if (!op.find || !op.replace) return `replace_literal requires find/replace at index ${index}.`;
      if (op.find.length > limits.maxText || op.replace.length > limits.maxText) {
        return `replace_literal payload too large at index ${index}.`;
      }
      continue;
    }
    if (op.type === "insert_after_literal") {
      if (!op.find || !op.insert) return `insert_after_literal requires find/insert at index ${index}.`;
      if (op.find.length > limits.maxText || op.insert.length > limits.maxText) {
        return `insert_after_literal payload too large at index ${index}.`;
      }
      continue;
    }
    if (op.type === "replace_regex_once") {
      if (!op.pattern || !op.replace) return `replace_regex_once requires pattern/replace at index ${index}.`;
      if (op.pattern.length > limits.maxText || op.replace.length > limits.maxText) {
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

export function applyHealOperations(specContent: string, operations: HealOperation[]): string {
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

export function buildHealPromptPayload(projectId: string, context: AiExecutionContext): HealPrompt {
  return {
    projectId,
    specPath: context.repoRelativePath,
    testTitle: context.failure.testTitle ?? null,
    selectedTestSnippet: (context.selectedTestSnippet || "").slice(0, 12000),
    structuredEvidenceSummary: (context.evidence.structuredSummary || "").slice(0, 3000),
    failureMessage: redactSecrets(context.failure.message ?? ""),
    stdout: redactSecrets((context.failure.stdout || "").slice(0, 4000)),
    stderr: redactSecrets((context.failure.stderr || "").slice(0, 4000)),
    specContent: context.specContent ?? "",
    failureClasses: context.evidence.failureClasses,
    reportSnippet: redactSecrets((context.evidence.reportSnippet || "").slice(0, 4000)),
    pageSignalsSnippet: redactSecrets((context.evidence.pageSignalsSnippet || "").slice(0, 4000)),
    errorContextSnippet: redactSecrets((context.evidence.errorContextSnippet || "").slice(0, 3000)),
    artifacts: context.evidence.artifacts.slice(0, 8).map((artifact) => ({
      type: artifact.type,
      path: artifact.path,
      label: artifact.label ?? null,
      excerpt: redactSecrets((artifact.excerpt || "").slice(0, 1200)),
    })),
  };
}

export async function withTimeout<T>(promise: Promise<T>, ms: number) {
  return Promise.race<T>([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`self-heal timeout after ${ms}ms`)), ms)
    ),
  ]);
}
