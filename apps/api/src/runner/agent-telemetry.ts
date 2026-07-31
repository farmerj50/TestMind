import { prisma } from "../prisma.js";

export type AgentRunMetrics = {
  sessionId: string;
  projectId: string;
  generationTimeMs: number;
  crawlTimeMs: number;
  specCount: number;
  testsPerPage: number;
  coveragePercent: number;
  repairTimeMs?: number;
  retestTimeMs?: number;
  tokenUsage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  estimatedCostUsd?: number;
  repairSuccessRate?: number;
  averageConfidence?: number;
};

const GPT4O_MINI_COST_PER_INPUT_TOKEN = 0.00000015;
const GPT4O_MINI_COST_PER_OUTPUT_TOKEN = 0.0000006;

export function estimateCostUsd(tokenUsage: AgentRunMetrics["tokenUsage"]): number {
  if (!tokenUsage) return 0;
  return (
    tokenUsage.promptTokens * GPT4O_MINI_COST_PER_INPUT_TOKEN +
    tokenUsage.completionTokens * GPT4O_MINI_COST_PER_OUTPUT_TOKEN
  );
}

export async function recordAgentRunMetrics(metrics: AgentRunMetrics): Promise<void> {
  const estimatedCostUsd = metrics.estimatedCostUsd ?? estimateCostUsd(metrics.tokenUsage);
  const enriched: AgentRunMetrics = { ...metrics, estimatedCostUsd };

  await prisma.agentSession.update({
    where: { id: metrics.sessionId },
    data: { metrics: enriched as any },
  });

  console.info(
    `[agent-telemetry] session=${metrics.sessionId} ` +
    `genMs=${metrics.generationTimeMs} crawlMs=${metrics.crawlTimeMs} ` +
    `specs=${metrics.specCount} ` +
    (metrics.tokenUsage ? `tokens=${metrics.tokenUsage.totalTokens} ` : "") +
    `cost=$${estimatedCostUsd.toFixed(6)}`
  );
}
