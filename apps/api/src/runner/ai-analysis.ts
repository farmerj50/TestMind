// apps/api/src/runner/ai-analysis.ts
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import OpenAI from "openai";
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";

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
  plan?: FixPlan;
};

const flagEnabled = () => {
  loadBackendEnv();
  const v = (process.env.ENABLE_AI_ANALYSIS || "").toLowerCase();
  return ["1", "true", "yes", "on"].includes(v) && !!process.env.OPENAI_API_KEY;
};

function getModel() {
  loadBackendEnv();
  return process.env.ANALYSIS_MODEL || "gpt-4o-mini";
}

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

export async function analyzeFailure(opts: {
  runId: string;
  outDir: string;
  stderr?: string;
  stdout?: string;
  reportPath?: string;
  grep?: string;
  file?: string;
  baseUrl?: string;
}) {
  if (!flagEnabled()) return null;
  try {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    let reportSnippet = "";
    if (opts.reportPath) {
      try {
        const raw = await fs.readFile(opts.reportPath, "utf8");
        reportSnippet = raw.slice(0, 4000);
      } catch {
        // ignore missing report
      }
    }
    let pageSignals = "";
    try {
      const raw = await fs.readFile(
        path.join(opts.outDir, "page-signals.json"),
        "utf8"
      );
      pageSignals = raw.slice(0, 8000);
    } catch {
      // ignore missing signals
    }

    const prompt = `
You are a senior QA triage assistant. Summarize the likely cause and remediation for this failed run.
Return JSON with keys: summary, cause, suggestion.

Context:
- baseUrl: ${opts.baseUrl || "unknown"}
- grep: ${opts.grep || "none"}
- file: ${opts.file || "none"}
- stderr: ${opts.stderr?.slice(0, 4000) || "n/a"}
- stdout: ${opts.stdout?.slice(0, 4000) || "n/a"}
- report.json snippet: ${reportSnippet}
- page-signals.json snippet: ${pageSignals || "n/a"}
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

    const plan = buildFixPlan(opts, parsed);
    const doc: AnalysisDocument = {
      ...parsed,
      plan,
    };
    const analysisPath = path.join(opts.outDir, "analysis.json");
    await fs.writeFile(analysisPath, JSON.stringify(doc, null, 2), "utf8");
    return parsed;
  } catch {
    return null;
  }
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
