import test from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../prisma.js";
import { canAffordNextStep, callOpenAiAndTrackCost } from "./dev-agent-budget.js";

test("canAffordNextStep allows unlimited spend when budgetUsd is null", () => {
  assert.equal(canAffordNextStep({ spentUsd: 999, budgetUsd: null }, 50), true);
});

test("canAffordNextStep refuses before the estimated cost would meet or exceed the budget", () => {
  assert.equal(canAffordNextStep({ spentUsd: 0.95, budgetUsd: 1.0 }, 0.1), false, "0.95 + 0.1 >= 1.0 must refuse");
  assert.equal(canAffordNextStep({ spentUsd: 0.5, budgetUsd: 1.0 }, 0.1), true, "0.5 + 0.1 < 1.0 must allow");
});

test("canAffordNextStep refuses exactly at the boundary (strict less-than)", () => {
  assert.equal(canAffordNextStep({ spentUsd: 0.9, budgetUsd: 1.0 }, 0.1), false);
});

test("callOpenAiAndTrackCost computes real cost from a fake OpenAI client's usage, persists it to a real row, and never constructs a real client - no network, no real key", async () => {
  const project = await prisma.project.findFirst({ orderBy: { createdAt: "asc" } });
  assert.ok(project, "a local test Postgres with at least one Project row is required for this test");

  const run = await prisma.devAgentRun.create({
    data: { projectId: project!.id, requestedBy: "test", mode: "assigned", status: "running" },
  });

  try {
    const fakeClient: any = {
      chat: {
        completions: {
          create: async () => ({
            choices: [{ message: { content: "mocked response" } }],
            usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 },
          }),
        },
      },
    };

    const result = await callOpenAiAndTrackCost({
      devAgentRunId: run.id,
      client: fakeClient,
      systemPrompt: "sys",
      userPrompt: "user",
    });

    assert.equal(result.content, "mocked response");
    assert.equal(result.promptTokens, 1000);
    assert.equal(result.completionTokens, 500);
    // 1000 * 0.00000015 + 500 * 0.0000006 = 0.00015 + 0.0003 = 0.00045
    assert.ok(Math.abs(result.costUsd - 0.00045) < 1e-9, `unexpected cost: ${result.costUsd}`);

    const updated = await prisma.devAgentRun.findUnique({ where: { id: run.id } });
    assert.ok(Math.abs((updated?.spentUsd ?? 0) - 0.00045) < 1e-9, "spentUsd must be persisted on the real row");
  } finally {
    await prisma.devAgentRun.delete({ where: { id: run.id } }).catch(() => {});
  }
});
