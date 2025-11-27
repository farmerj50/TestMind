// apps/api/src/runner/ai-analysis.ts
import fs from "node:fs/promises";
import path from "node:path";
import OpenAI from "openai";

export type AnalysisResult = {
  summary: string;
  cause: string;
  suggestion: string;
  model: string;
};

const flagEnabled = () => {
  const v = (process.env.ENABLE_AI_ANALYSIS || "").toLowerCase();
  return ["1", "true", "yes", "on"].includes(v) && !!process.env.OPENAI_API_KEY;
};

const MODEL = process.env.ANALYSIS_MODEL || "gpt-4o-mini";

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
`;

    const completion = await openai.chat.completions.create({
      model: MODEL,
      temperature: 0.2,
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
          model: MODEL,
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
        model: MODEL,
      };
    }

    const analysisPath = path.join(opts.outDir, "analysis.json");
    await fs.writeFile(analysisPath, JSON.stringify(parsed, null, 2), "utf8");
    return parsed;
  } catch {
    return null;
  }
}
