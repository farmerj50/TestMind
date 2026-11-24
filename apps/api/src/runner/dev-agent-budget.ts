import OpenAI from "openai";
import { prisma } from "../prisma.js";
import { resolveOpenAiKey } from "./llm.js";
import { estimateCostUsd } from "./agent-telemetry.js";

// Correction #2 (approved plan): checked BEFORE an expensive operation starts, not only
// reconciled after. A run with no budgetUsd configured is treated as unlimited (explicit
// opt-out, matching this feature's own "budgets" field being optional by design).
export function canAffordNextStep(run: { spentUsd: number; budgetUsd: number | null }, estimatedCostUsd: number): boolean {
  if (run.budgetUsd == null) return true;
  return run.spentUsd + estimatedCostUsd < run.budgetUsd;
}

// A conservative flat estimate for a single plan/code-phase LLM call, used for the
// pre-check in canAffordNextStep before the real call's actual cost is known. Deliberately
// generous (worst-case-ish for a gpt-4o-mini-class call with a few KB of context) rather
// than optimistic - the point of a pre-check is to refuse before spending, not to be exact.
export const CONSERVATIVE_LLM_STEP_ESTIMATE_USD = 0.01;

export async function recordSpend(devAgentRunId: string, costUsd: number): Promise<void> {
  if (costUsd <= 0) return;
  await prisma.devAgentRun.update({
    where: { id: devAgentRunId },
    data: { spentUsd: { increment: costUsd } },
  });
}

export type BudgetedCompletion = { content: string; costUsd: number; promptTokens: number; completionTokens: number };

// Resolves the project's OpenAI key (existing resolveOpenAiKey, reused as-is), makes the
// call, captures real token usage, computes real cost via the existing estimateCostUsd
// pricing table (not a new one), and persists the spend - the only place in this feature
// that actually talks to OpenAI, so cost tracking can never be bypassed by a different
// call site.
export async function callOpenAiAndTrackCost(opts: {
  devAgentRunId: string;
  systemPrompt: string;
  userPrompt: string;
  model?: string;
  client: OpenAI; // always injected - real client from resolveRealOpenAiClient() in
                   // production, a fake/mock in tests. Never constructed inside this function.
}): Promise<BudgetedCompletion> {
  const { devAgentRunId, systemPrompt, userPrompt, model = "gpt-4o-mini", client } = opts;

  const response = await client.chat.completions.create({
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
  });

  const usage = response.usage;
  const promptTokens = usage?.prompt_tokens ?? 0;
  const completionTokens = usage?.completion_tokens ?? 0;
  const costUsd = estimateCostUsd({ promptTokens, completionTokens, totalTokens: promptTokens + completionTokens });

  await recordSpend(devAgentRunId, costUsd);

  return { content: response.choices[0]?.message?.content ?? "", costUsd, promptTokens, completionTokens };
}

export async function resolveRealOpenAiClient(projectId: string): Promise<OpenAI> {
  const apiKey = await resolveOpenAiKey(projectId);
  if (!apiKey) throw new Error("OPENAI_API_KEY is required to run Autonomous Development Mode's code phase.");
  return new OpenAI({ apiKey });
}
