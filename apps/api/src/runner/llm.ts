import OpenAI from "openai";

const MODEL = process.env.HEALING_LLM_MODEL || "gpt-4o-mini";

let client: OpenAI | null = null;

function getClient() {
  if (client) return client;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is required to run self-healing.");
  client = new OpenAI({ apiKey });
  return client;
}

export type HealPrompt = {
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

export async function requestSpecHeal(prompt: HealPrompt): Promise<HealResponse> {
  const openai = getClient();

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
