/** Select an existing pipeline before applying repository-specific prerequisites. */
export function autonomousPipeline(input: {
  taskKind?: "auto" | "test_generation" | "code_edit";
  instructionText?: string | null;
  baseUrl?: string | null;
  mode?: string;
}): "qe" | "dev" {
  if (!input.baseUrl || input.taskKind === "code_edit" || (input.mode && input.mode !== "assigned")) return "dev";
  if (input.taskKind === "test_generation") return "qe";
  const text = input.instructionText ?? "";
  // Unit/source verification stays with Dev, even when the project has a website.
  if (/\b(unit|component|jest|vitest|repository-level|source-based|repository tests|repo tests)\b/i.test(text) || /\b(fix|refactor|edit|modify)\b/i.test(text) || /\bimplement\b/i.test(text) && !/\b(tests?|specs?)\b/i.test(text)) return "dev";
  return !text.trim() || /\b(tests?|testing|specs?|verify|qa|coverage|user stor(?:y|ies))\b/i.test(text) ? "qe" : "dev";
}

/** Compatibility for newly queued autonomous QA jobs from schedules/operator clients. */
export function qeContextForLegacyRequest(context: Record<string, any>, baseUrl: string): Record<string, any> & { qe: Record<string, any> } {
  const story = typeof context.userStory === "string" ? context.userStory : undefined;
  const inputKind = story ? "user_story" : context.scope === "page" ? "page" : "app_url";
  return { ...context, autonomous: true, baseUrl, qe: { inputKind, input: story || baseUrl, baseUrl,
    ...(typeof context.maxPages === "number" ? { maxPages: Math.max(1, Math.min(50, context.maxPages)) } : {}),
    ...(context.credentialRef ? { credentialRef: context.credentialRef } : {}),
    ...(context.repository ? { repository: context.repository } : {}),
  } };
}
