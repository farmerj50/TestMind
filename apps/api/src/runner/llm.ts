import OpenAI from "openai";
import { config as loadEnv } from "dotenv";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prisma } from "../prisma.js";
import { decryptSecret } from "../lib/crypto.js";

const MODEL = process.env.HEALING_LLM_MODEL || "gpt-4o-mini";

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

async function getClient(projectId?: string) {
  loadBackendEnv();
  const apiKey = await resolveOpenAiKey(projectId);
  if (!apiKey) throw new Error("OPENAI_API_KEY is required to run self-healing.");
  if (client && clientKey === apiKey) return client;
  client = new OpenAI({ apiKey });
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
    prompt.stdout ? `stdout:\n${prompt.stdout}` : "",
    prompt.stderr ? `stderr:\n${prompt.stderr}` : "",
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
    prompt.specContent,
    "```",
    "Respond ONLY with JSON:",
    '{"summary": string, "operations": Array<replace_literal|replace_regex_once|insert_after_literal>}',
  ].join("\n\n");

  const completion = await openai.chat.completions.create({
    model: MODEL,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: system },
      { role: "user", content: userContent },
    ],
  });

  const raw = completion.choices[0]?.message?.content?.trim() || "{}";
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`LLM returned invalid JSON: ${(err as Error).message}`);
  }

  const summary = typeof parsed.summary === "string" ? parsed.summary : "LLM patch operations";
  const operations = Array.isArray(parsed.operations) ? parsed.operations : [];
  if (!operations.length) {
    throw new Error("LLM did not return patch operations.");
  }
  return { summary, operations, raw };
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
    prompt.stdout ? `stdout:\n${prompt.stdout}` : "",
    prompt.stderr ? `stderr:\n${prompt.stderr}` : "",
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
    prompt.specContent,
    "```",
    "Respond ONLY with JSON: {\"summary\": string, \"updatedSpec\": string}",
  ].join("\n\n");

  const completion = await openai.chat.completions.create({
    model: MODEL,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: system },
      { role: "user", content: userContent },
    ],
  });

  const raw = completion.choices[0]?.message?.content?.trim() || "{}";
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`LLM returned invalid JSON: ${(err as Error).message}`);
  }

  const summary = typeof parsed.summary === "string" ? parsed.summary : "LLM updated spec";
  const updatedSpec = typeof parsed.updatedSpec === "string" ? parsed.updatedSpec : "";
  if (!updatedSpec) {
    throw new Error("LLM did not return updatedSpec content.");
  }

  return { summary, updatedSpec, raw };
}
