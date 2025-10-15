// apps/api/src/testmind/pipeline/generate-plan.ts
import type { TestPlan } from "../core/plan.js";
import { personaBundles, type Persona, type PatternInput } from "../core/pattern.js";

export function generatePlan(input: PatternInput, persona: Persona = "sdet"): TestPlan {
  const patterns = personaBundles[persona];
  const cases = patterns.flatMap((p) => p(input));

  return {
    baseUrl: input.env.baseUrl ?? "/",
    targets: [],
    cases,
    meta: { persona, count: cases.length, generatedAt: new Date().toISOString() },
  };
}

