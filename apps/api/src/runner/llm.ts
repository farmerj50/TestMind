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
  failureMessage?: string | null;
  stdout?: string;
  stderr?: string;
  specContent: string;
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
    "Return JSON with keys `summary` and `operations` only.",
    "Allowed operation types:",
    "replace_literal {type, find, replace}",
    "replace_regex_once {type, pattern, flags?, replace}",
    "insert_after_literal {type, find, insert}",
    "Do not add imports. Do not rename tests. Keep changes minimal and deterministic.",
  ].join(" ");

  const failureDetails = [
    `Spec path: ${prompt.specPath}`,
    prompt.failureMessage ? `Failure: ${prompt.failureMessage}` : "",
    prompt.stdout ? `stdout:\n${prompt.stdout}` : "",
    prompt.stderr ? `stderr:\n${prompt.stderr}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  const userContent = [
    failureDetails,
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
    "Return JSON with keys `summary` (short sentence about fix) and `updatedSpec` (full updated TypeScript file).",
    "Do not change the test name or add new dependencies. Keep assertions deterministic.",
  ].join(" ");

  const failureDetails = [
    `Spec path: ${prompt.specPath}`,
    prompt.failureMessage ? `Failure: ${prompt.failureMessage}` : "",
    prompt.stdout ? `stdout:\n${prompt.stdout}` : "",
    prompt.stderr ? `stderr:\n${prompt.stderr}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  const userContent = [
    failureDetails,
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
