import type { TestPlan } from "../core/plan.js";
import { personaBundles, type Persona, type PatternInput } from "../core/pattern.js";

export function generatePlan(input: PatternInput, persona: Persona = "sdet"): TestPlan {
  const patterns = personaBundles[persona];
  const cases = patterns.flatMap((p) => p(input));

  return {
    baseUrl: input.env.baseUrl ?? "/",
    cases,                                        // <— unified here
    meta: { persona, count: cases.length, generatedAt: new Date().toISOString() },
  };
}


