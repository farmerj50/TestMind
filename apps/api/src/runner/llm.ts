import OpenAI from "openai";
import { config as loadEnv } from "dotenv";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { prisma } from "../prisma.js";
import { decryptSecret } from "../lib/crypto.js";

const MODEL = process.env.HEALING_LLM_MODEL || "gpt-4o-mini";

/**
 * Normalize LLM patch-op payloads to the exact discriminator values and field names
 * Zod expects. The model sometimes returns abbreviated type names, kebab/camel-case
 * variants, omits `type` entirely, or uses field aliases like `replacement`.
 * We normalize those before schema validation so a sloppy-but-correct response
 * doesn't trigger a hard failure and skip the fallback rewrite.
 */
function normalizeOpTypes(raw: string): string {
  const normalizeToken = (value: string) =>
    value
      .trim()
      .toLowerCase()
      .replace(/([a-z])([A-Z])/g, "$1_$2")
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .replace(/_+/g, "_");

  const canonicalType = (value: unknown, op?: Record<string, unknown>): string | undefined => {
    if (typeof value === "string" && value.trim()) {
      const normalized = normalizeToken(value);
      const TYPE_MAP: Record<string, string> = {
        replace: "replace_literal",
        replace_literal: "replace_literal",
        replace_text: "replace_literal",
        replace_string: "replace_literal",
        replace_line: "replace_literal",
        replace_once: "replace_literal",
        replace_literal_once: "replace_literal",
        literal_replace: "replace_literal",
        replace_regex: "replace_regex_once",
        replace_regex_once: "replace_regex_once",
        regex_replace: "replace_regex_once",
        regex_replace_once: "replace_regex_once",
        regex_once: "replace_regex_once",
        pattern_replace: "replace_regex_once",
        replace_pattern: "replace_regex_once",
        insert: "insert_after_literal",
        insert_after: "insert_after_literal",
        insert_after_literal: "insert_after_literal",
        append_after: "insert_after_literal",
        append_after_literal: "insert_after_literal",
      };
      if (TYPE_MAP[normalized]) return TYPE_MAP[normalized];
    }

    if (!op) return undefined;
    const hasFind = typeof op.find === "string" || typeof op.match === "string" || typeof op.anchor === "string";
    const hasReplace =
      typeof op.replace === "string" ||
      typeof op.replacement === "string" ||
      typeof op.value === "string" ||
      typeof op.newText === "string";
    const hasPattern = typeof op.pattern === "string" || typeof op.regex === "string";
    const hasInsert =
      typeof op.insert === "string" ||
      typeof op.text === "string" ||
      typeof op.content === "string";

    if (hasPattern && hasReplace) return "replace_regex_once";
    if (hasFind && hasInsert && !hasReplace) return "insert_after_literal";
    if (hasFind && hasReplace) return "replace_literal";
    return undefined;
  };

  const normalizeOperation = (op: Record<string, unknown>) => {
    const type = canonicalType(op.type, op);
    if (type) op.type = type;

    if (type === "replace_literal") {
      if (typeof op.find !== "string") {
        const nextFind = [op.match, op.target, op.search, op.needle].find((v) => typeof v === "string");
        if (typeof nextFind === "string") op.find = nextFind;
      }
      if (typeof op.replace !== "string") {
        const nextReplace = [op.replacement, op.value, op.newText, op.text].find((v) => typeof v === "string");
        if (typeof nextReplace === "string") op.replace = nextReplace;
      }
    }

    if (type === "replace_regex_once") {
      if (typeof op.pattern !== "string") {
        const nextPattern = [op.regex, op.find, op.match, op.search].find((v) => typeof v === "string");
        if (typeof nextPattern === "string") op.pattern = nextPattern;
      }
      if (typeof op.replace !== "string") {
        const nextReplace = [op.replacement, op.value, op.newText, op.text].find((v) => typeof v === "string");
        if (typeof nextReplace === "string") op.replace = nextReplace;
      }
    }

    if (type === "insert_after_literal") {
      if (typeof op.find !== "string") {
        const nextFind = [op.anchor, op.after, op.match, op.target, op.needle].find((v) => typeof v === "string");
        if (typeof nextFind === "string") op.find = nextFind;
      }
      if (typeof op.insert !== "string") {
        const nextInsert = [op.text, op.content, op.value, op.replacement, op.newText].find(
          (v) => typeof v === "string"
        );
        if (typeof nextInsert === "string") op.insert = nextInsert;
      }
    }
  };

  try {
    const obj = JSON.parse(raw);
    if (Array.isArray(obj?.operations)) {
      for (const op of obj.operations) {
        if (op && typeof op === "object" && !Array.isArray(op)) {
          normalizeOperation(op as Record<string, unknown>);
        }
      }
    }
    return JSON.stringify(obj);
  } catch {
    return raw; // if parse fails, let parseModelJson handle the error
  }
}

/** Strip a single outer markdown code fence (` ```ts ` / ` ``` `) if present. */
function stripOuterCodeFence(content: string): string {
  const trimmed = content.trim();
  const match = trimmed.match(/^```[A-Za-z0-9_-]*\r?\n([\s\S]*?)\r?\n```\s*$/);
  if (match) return `${match[1].trimEnd()}\n`;
  return content;
}

let client: OpenAI | null = null;
let clientKey: string | null = null;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function loadBackendEnv() {
  if (process.env.OPENAI_API_KEY) return;
  const candidates = [
    path.resolve(__dirname, "..", "..", ".env"),
    path.resolve(__dirname, "..", "..", "..", ".env"),
  ];
  for (const candidate of candidates) {
    if (!fsSync.existsSync(candidate)) continue;
    loadEnv({ path: candidate });
    if (process.env.OPENAI_API_KEY) return;
  }
}

const OPENAI_SECRET_KEYS = ["OPENAI_API_KEY", "OPEN_API_KEY"] as const;

async function resolveOpenAiKey(projectId?: string) {
  loadBackendEnv();
  if (!projectId) {
    return process.env.OPENAI_API_KEY ?? "";
  }
  const secrets = await prisma.projectSecret.findMany({
    where: { projectId },
    select: { key: true, value: true },
  });
  const secret = secrets.find((s) => OPENAI_SECRET_KEYS.includes(s.key as any));
  if (!secret) return process.env.OPENAI_API_KEY ?? "";
  try {
    return decryptSecret(secret.value);
  } catch {
    throw new Error("Failed to decrypt OPENAI_API_KEY secret. Please re-save it.");
  }
}

// Per-call HTTP timeout — cancels the in-flight request at the network level.
// Promise.race alone doesn't cancel the underlying fetch, so the OpenAI SDK
// timeout option is the correct mechanism.
const LLM_REQUEST_TIMEOUT_MS = Number(
  process.env.HEALING_LLM_TIMEOUT_MS ?? 30_000
);

// Keep prompts tight — large stdout/stderr balloons token count and slows responses.
const MAX_STDOUT_CHARS = 600;
const MAX_STDERR_CHARS = 400;
// Cap full spec to avoid multi-hundred-KB generated files blowing out the context window.
// The selectedTestSnippet already contains the failing test block; specContent is supplementary context.
// Keeping this tight (8k) because json_object structured calls on gpt-4o-mini slow dramatically with large inputs.
const MAX_SPEC_CHARS = 8_000;

async function getClient(projectId?: string) {
  loadBackendEnv();
  const apiKey = await resolveOpenAiKey(projectId);
  if (!apiKey) throw new Error("OPENAI_API_KEY is required to run self-healing.");
  if (client && clientKey === apiKey) return client;
  client = new OpenAI({ apiKey, timeout: LLM_REQUEST_TIMEOUT_MS });
  clientKey = apiKey;
  return client;
}

export type HealPrompt = {
  projectId?: string;
  specPath: string;
  testTitle?: string | null;
  selectedTestSnippet?: string;
  structuredEvidenceSummary?: string;
  failureMessage?: string | null;
  stdout?: string;
  stderr?: string;
  specContent: string;
  failureClasses?: string[];
  reportSnippet?: string;
  pageSignalsSnippet?: string;
  errorContextSnippet?: string;
  artifacts?: Array<{
    type: string;
    path: string;
    label?: string | null;
    excerpt?: string | null;
  }>;
  previousAttemptRejectedReason?: string | null;
};

export type HealResponse = {
  summary: string;
  updatedSpec: string;
  raw: string;
};

export type HealOperation =
  | { type: "replace_literal"; find: string; replace: string }
  | { type: "replace_regex_once"; pattern: string; flags?: string; replace: string }
  | { type: "insert_after_literal"; find: string; insert: string };

export type HealPatchResponse = {
  summary: string;
  operations: HealOperation[];
  raw: string;
};

const healOperationSchema: z.ZodType<HealOperation> = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("replace_literal"),
    find: z.string().min(1),
    replace: z.string().min(1),
  }),
  z.object({
    type: z.literal("replace_regex_once"),
    pattern: z.string().min(1),
    flags: z.string().optional(),
    replace: z.string().min(1),
  }),
  z.object({
    type: z.literal("insert_after_literal"),
    find: z.string().min(1),
    insert: z.string().min(1),
  }),
]) as z.ZodType<HealOperation>;

const healPatchResponseSchema = z.object({
  summary: z.string(),
  operations: z.array(healOperationSchema).min(1),
});

const healSelectedBlockResponseSchema = z.object({
  summary: z.string(),
  updatedTestBlock: z.string().min(1),
});

const healFileResponseSchema = z.object({
  summary: z.string(),
  updatedSpec: z.string().min(1),
});

const patchOpsJsonSchema = {
  name: "testmind_patch_ops",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["summary", "operations"],
    properties: {
      summary: { type: "string" },
      operations: {
        type: "array",
        minItems: 1,
        items: {
          anyOf: [
            {
              type: "object",
              additionalProperties: false,
              required: ["type", "find", "replace"],
              properties: {
                type: { const: "replace_literal" },
                find: { type: "string" },
                replace: { type: "string" },
              },
            },
            {
              type: "object",
              additionalProperties: false,
              required: ["type", "pattern", "replace"],
              properties: {
                type: { const: "replace_regex_once" },
                pattern: { type: "string" },
                flags: { type: "string" },
                replace: { type: "string" },
              },
            },
            {
              type: "object",
              additionalProperties: false,
              required: ["type", "find", "insert"],
              properties: {
                type: { const: "insert_after_literal" },
                find: { type: "string" },
                insert: { type: "string" },
              },
            },
          ],
        },
      },
    },
  },
} as const;

const selectedBlockJsonSchema = {
  name: "testmind_selected_test_rewrite",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["summary", "updatedTestBlock"],
    properties: {
      summary: { type: "string" },
      updatedTestBlock: { type: "string" },
    },
  },
} as const;

const updatedFileJsonSchema = {
  name: "testmind_full_spec_rewrite",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["summary", "updatedSpec"],
    properties: {
      summary: { type: "string" },
      updatedSpec: { type: "string" },
    },
  },
} as const;

function extractJsonPayload(raw: string) {
  const trimmed = raw.trim();
  if (!trimmed) return "{}";
  const fenced = trimmed.match(/^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/i);
  if (fenced?.[1]) return fenced[1].trim();
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }
  return trimmed;
}

function parseModelJson<T>(raw: string, schema: z.ZodType<T>): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonPayload(raw));
  } catch (err) {
    throw new Error(`LLM returned invalid JSON: ${(err as Error).message}`);
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`LLM returned invalid JSON shape: ${result.error.issues[0]?.message ?? "unknown schema error"}`);
  }
  return result.data;
}

async function createStructuredChatCompletion(input: {
  openai: OpenAI;
  system: string;
  userContent: string;
  maxTokens: number;
  jsonSchema: { name: string; strict: boolean; schema: Record<string, unknown> };
}) {
  // Use json_object instead of json_schema to avoid anyOf constraint engine overhead.
  // json_schema with anyOf discriminated unions causes significant latency on gpt-4o-mini.
  // Zod validation in parseModelJson handles schema compliance and the caller's catch block handles fallback.
  const completion = await input.openai.chat.completions.create({
    model: MODEL,
    response_format: { type: "json_object" },
    max_tokens: input.maxTokens,
    messages: [
      { role: "system", content: input.system },
      { role: "user", content: input.userContent },
    ],
  });

  return completion.choices[0]?.message?.content?.trim() || "{}";
}

export async function requestSpecPatchOps(prompt: HealPrompt): Promise<HealPatchResponse> {
  const openai = await getClient(prompt.projectId);

  const system = [
    "You are TestMind, an autonomous QA engineer.",
    "You receive a failing Playwright test spec and must provide deterministic patch operations.",
    "Your job is to repair the selected test, not diagnose the application or recommend product changes.",
    "Prefer local edits inside the selected failing test block over broad file rewrites.",
    "For tests titled like Navigate X -> Y or Navigate X → Y, final assertions must validate the destination route Y, not the source route X.",
    "When page signals or screenshots reveal the visible heading/title, prefer updating stale text or heading assertions to match that live evidence.",
    "If direct page.goto navigation is what fails due to redirects or pathname mismatch, prefer switching the selected test to the shared clickNavLink/page navigation helper for that target route.",
    "If the selected test contains a generated missing-locator comment for a navigation step, prefer replacing that comment with the shared clickNavLink plus URL/identity assertions for the destination route.",
    "If identity checks fail before locator resolution, prefer replacing stale ensurePageIdentity assumptions with live heading/title evidence from page signals.",
    "For login/auth failures, prefer repairing sharedLogin selectors with label, placeholder, role, and autocomplete fallbacks.",
    "For malformed selector parse errors, prefer sanitizing or replacing invalid CSS fragments with stable attribute, label, role, or testid selectors.",
    "Return JSON with keys `summary` and `operations` only.",
    "Allowed operation types:",
    "replace_literal {type, find, replace}",
    "replace_regex_once {type, pattern, flags?, replace}",
    "insert_after_literal {type, find, insert}",
    "Do not add imports. Do not rename tests. Keep changes minimal and deterministic.",
  ].join(" ");

  const failureDetails = [
    `Spec path: ${prompt.specPath}`,
    prompt.testTitle ? `Selected test: ${prompt.testTitle}` : "",
    prompt.failureMessage ? `Failure: ${prompt.failureMessage}` : "",
    prompt.stdout?.trim() ? `stdout:\n${prompt.stdout.slice(0, MAX_STDOUT_CHARS)}` : "",
    prompt.stderr?.trim() ? `stderr:\n${prompt.stderr.slice(0, MAX_STDERR_CHARS)}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  const userContent = [
    failureDetails,
    prompt.failureClasses?.length ? `Failure classes: ${prompt.failureClasses.join(", ")}` : "",
    prompt.structuredEvidenceSummary ? `Structured evidence:\n${prompt.structuredEvidenceSummary}` : "",
    prompt.previousAttemptRejectedReason
      ? `Previous repair attempt was rejected: ${prompt.previousAttemptRejectedReason}`
      : "",
    prompt.reportSnippet ? `report.json snippet:\n${prompt.reportSnippet}` : "",
    prompt.pageSignalsSnippet ? `page-signals.json snippet:\n${prompt.pageSignalsSnippet}` : "",
    prompt.errorContextSnippet ? `error-context snippet:\n${prompt.errorContextSnippet}` : "",
    prompt.artifacts?.length
      ? `Artifacts:\n${prompt.artifacts
          .map((artifact) => `- [${artifact.type}] ${artifact.path}${artifact.excerpt ? `\n${artifact.excerpt}` : ""}`)
          .join("\n\n")}`
      : "",
    prompt.selectedTestSnippet
      ? `Selected failing test block:\n\`\`\`ts\n${prompt.selectedTestSnippet}\n\`\`\``
      : "",
    "Current spec file:",
    "```ts",
    prompt.specContent.slice(0, MAX_SPEC_CHARS),
    "```",
    "Respond ONLY with JSON:",
    '{"summary": string, "operations": Array<replace_literal|replace_regex_once|insert_after_literal>}',
  ].join("\n\n");

  const raw = await createStructuredChatCompletion({
    openai,
    system,
    userContent,
    maxTokens: 1200,
    jsonSchema: patchOpsJsonSchema,
  });

  const parsed = parseModelJson(normalizeOpTypes(raw), healPatchResponseSchema);
  return { summary: parsed.summary || "LLM patch operations", operations: parsed.operations, raw };
}

export async function requestSpecHeal(prompt: HealPrompt): Promise<HealResponse> {
  const openai = await getClient(prompt.projectId);

  const system = [
    "You are TestMind, an autonomous QA engineer.",
    "You receive a failing Playwright test spec and must rewrite it so the intent still holds but the failure is fixed.",
    "Your job is to repair the selected test, not diagnose the application or recommend app-side changes.",
    "Prefer the smallest test-local change that makes the selected test deterministic and correct.",
    "For tests titled like Navigate X -> Y or Navigate X → Y, final assertions must validate the destination route Y.",
    "Use pageSignals, error-context, screenshots, and trace/report snippets to replace stale headings, text assertions, or route expectations with live evidence.",
    "If page.goto is being redirected or pathname checks are failing, prefer switching the selected navigation step to the shared clickNavLink/path-based navigation flow instead of changing app behavior assumptions.",
    "If a selected test contains a generated missing-locator comment for navigation, replace that comment with the shared clickNavLink plus URL/identity verification for the destination route.",
    "If ensurePageIdentity is stale and page signals reveal the real heading or title, use that live evidence to repair the selected test.",
    "For login/auth failures, prefer strengthening sharedLogin selectors with stable label, placeholder, role, and autocomplete fallbacks.",
    "For selector parse failures, remove malformed CSS fragments and replace them with stable label, role, testid, placeholder, or attribute selectors.",
    "Return JSON with keys `summary` (short sentence about fix) and `updatedSpec` (full updated TypeScript file).",
    "Do not change the test name or add new dependencies. Keep assertions deterministic.",
  ].join(" ");

  const failureDetails = [
    `Spec path: ${prompt.specPath}`,
    prompt.testTitle ? `Selected test: ${prompt.testTitle}` : "",
    prompt.failureMessage ? `Failure: ${prompt.failureMessage}` : "",
    prompt.stdout?.trim() ? `stdout:\n${prompt.stdout.slice(0, MAX_STDOUT_CHARS)}` : "",
    prompt.stderr?.trim() ? `stderr:\n${prompt.stderr.slice(0, MAX_STDERR_CHARS)}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  const specContent = prompt.specContent.slice(0, MAX_SPEC_CHARS);
  const sharedContext = [
    failureDetails,
    prompt.failureClasses?.length ? `Failure classes: ${prompt.failureClasses.join(", ")}` : "",
    prompt.structuredEvidenceSummary ? `Structured evidence:\n${prompt.structuredEvidenceSummary}` : "",
    prompt.previousAttemptRejectedReason
      ? `Previous repair attempt was rejected: ${prompt.previousAttemptRejectedReason}`
      : "",
    prompt.reportSnippet ? `report.json snippet:\n${prompt.reportSnippet}` : "",
    prompt.pageSignalsSnippet ? `page-signals.json snippet:\n${prompt.pageSignalsSnippet}` : "",
    prompt.errorContextSnippet ? `error-context snippet:\n${prompt.errorContextSnippet}` : "",
    prompt.artifacts?.length
      ? `Artifacts:\n${prompt.artifacts
          .map((artifact) => `- [${artifact.type}] ${artifact.path}${artifact.excerpt ? `\n${artifact.excerpt}` : ""}`)
          .join("\n\n")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  const selectedTestSnippet = prompt.selectedTestSnippet?.trim() || "";
  const canRewriteSelectedBlock =
    !!selectedTestSnippet && prompt.specContent.includes(prompt.selectedTestSnippet ?? "");

  if (canRewriteSelectedBlock) {
    try {
      const blockSystem = [
        system,
        "Rewrite only the selected failing test block.",
        "Do not include the full file.",
        "Keep the surrounding helper functions and other tests unchanged.",
        "Return JSON with keys `summary` and `updatedTestBlock` only.",
      ].join(" ");

      const blockUserContent = [
        sharedContext,
        `Selected failing test block:\n\`\`\`ts\n${prompt.selectedTestSnippet}\n\`\`\``,
        "Current spec file for surrounding context:",
        "```ts",
        specContent,
        "```",
        'Respond ONLY with JSON: {"summary": string, "updatedTestBlock": string}',
      ]
        .filter(Boolean)
        .join("\n\n");

      const raw = await createStructuredChatCompletion({
        openai,
        system: blockSystem,
        userContent: blockUserContent,
        maxTokens: Math.min(2500, Math.max(900, Math.ceil(selectedTestSnippet.length / 2) + 400)),
        jsonSchema: selectedBlockJsonSchema,
      });

      const parsed = parseModelJson(raw, healSelectedBlockResponseSchema);
      // Strip outer markdown code fences the LLM may wrap around the block
      const updatedTestBlock = stripOuterCodeFence(parsed.updatedTestBlock);
      const updatedSpec = prompt.specContent.replace(prompt.selectedTestSnippet!, updatedTestBlock);
      if (updatedSpec === prompt.specContent) {
        throw new Error("LLM returned updatedTestBlock, but the original selected test block could not be replaced.");
      }
      return {
        summary: parsed.summary || "LLM updated selected test block",
        updatedSpec,
        raw,
      };
    } catch {
      // Fall through to the full-file rewrite path when selected-block output is unusable.
    }
  }

  const userContent = [
    sharedContext,
    prompt.selectedTestSnippet
      ? `Selected failing test block:\n\`\`\`ts\n${prompt.selectedTestSnippet}\n\`\`\``
      : "",
    "Current spec file:",
    "```ts",
    specContent,
    "```",
    'Respond ONLY with JSON: {"summary": string, "updatedSpec": string}',
  ]
    .filter(Boolean)
    .join("\n\n");

  const raw = await createStructuredChatCompletion({
    openai,
    system,
    userContent,
    maxTokens: Math.min(4000, Math.ceil(specContent.length / 2) + 500),
    jsonSchema: updatedFileJsonSchema,
  });

  const parsed = parseModelJson(raw, healFileResponseSchema);
  return {
    summary: parsed.summary || "LLM updated spec",
    updatedSpec: stripOuterCodeFence(parsed.updatedSpec),
    raw,
  };
}
