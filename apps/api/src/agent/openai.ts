import OpenAI from "openai";
import type { RouteScan } from "../testmind/discover.js";
import type { PageAnalysisResult, AgentScenarioPayload } from "./types.js";

const MODEL = process.env.AGENT_MODEL_MODEL || process.env.AGENT_MODEL || "gpt-4o-mini";

const clients = new Map<string, OpenAI>();

function ensureClient(apiKey?: string) {
  const resolved = apiKey ?? process.env.OPENAI_API_KEY;
  if (!resolved) throw new Error("OPENAI_API_KEY is required for the agent.");
  const existing = clients.get(resolved);
  if (existing) return existing;
  const created = new OpenAI({ apiKey: resolved });
  clients.set(resolved, created);
  return created;
}

export async function requestPageAnalysis(opts: {
  baseUrl: string;
  url: string;
  instructions?: string;
  scan: RouteScan;
  apiKey?: string;
}): Promise<PageAnalysisResult> {
  const openai = ensureClient(opts.apiKey);
  const payload = {
    baseUrl: opts.baseUrl,
    pageUrl: opts.url,
    instructions: opts.instructions ?? null,
    scan: {
      title: opts.scan.title,
      links: opts.scan.links?.slice(0, 25),
      buttons: opts.scan.buttons?.slice(0, 25),
      fileInputs: opts.scan.fileInputs,
      fields: opts.scan.fields,
    },
  };

  const completion = await openai.chat.completions.create({
    model: MODEL,
    temperature: 0.1,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: [
          "You are TestMind, an autonomous QA agent.",
          "Given page metadata, produce exhaustive scenarios covering statement, branch, edge, decision, and security testing.",
          "Return JSON with keys: summary (string), coverage (object with percentages), scenarios (array).",
          "Each scenario requires: title, coverageType, description, tags, risk (low|medium|high), steps (array of actions).",
          "Steps should be normalized objects: { kind, target, value, note }.",
        ].join(" "),
      },
      {
        role: "user",
        content: JSON.stringify(payload, null, 2),
      },
    ],
  });

  const raw = completion.choices[0]?.message?.content?.trim() || "{}";
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`LLM returned invalid JSON: ${(err as Error).message}`);
  }

  const normalizeScenario = (s: any): AgentScenarioPayload => ({
    title: String(s.title || "Scenario"),
    coverageType: ((
      typeof s.coverageType === "string" && s.coverageType.length
        ? s.coverageType.toLowerCase()
        : "other"
    ) as AgentScenarioPayload["coverageType"]),
    description: typeof s.description === "string" ? s.description : undefined,
    tags: Array.isArray(s.tags) ? s.tags.map((t: any) => String(t)).filter(Boolean) : [],
    risk:
      s.risk === "low" || s.risk === "high" || s.risk === "medium"
        ? s.risk
        : "medium",
    steps: Array.isArray(s.steps)
      ? s.steps.map((step: any) => ({
          kind: typeof step.kind === "string" ? step.kind : "custom",
          target: typeof step.target === "string" ? step.target : undefined,
          value: typeof step.value === "string" ? step.value : undefined,
          note: typeof step.note === "string" ? step.note : undefined,
        }))
      : [],
  });

  const result: PageAnalysisResult = {
    summary: typeof parsed.summary === "string" ? parsed.summary : "",
    coverage: typeof parsed.coverage === "object" && parsed.coverage
      ? parsed.coverage
      : {},
    scenarios: Array.isArray(parsed.scenarios)
      ? parsed.scenarios.map(normalizeScenario)
      : [],
  };

  return result;
}
