import { playwrightFailureAdapter } from "./playwright.js";
import type { FrameworkFailureAdapter, FrameworkParseInput, NormalizedFailure } from "./types.js";
import { normalizeFrameworkId } from "./types.js";

const adapters = new Map<string, FrameworkFailureAdapter>();

function register(adapter: FrameworkFailureAdapter) {
  adapters.set(adapter.framework, adapter);
}

register(playwrightFailureAdapter);

export function registerFrameworkAdapter(adapter: FrameworkFailureAdapter) {
  register(adapter);
}

export function getFrameworkAdapter(framework: string) {
  const normalized = normalizeFrameworkId(framework);
  if (!normalized) return null;
  return adapters.get(normalized) ?? null;
}

export function listFrameworkAdapters() {
  return [...adapters.values()];
}

export async function parseNormalizedFailures(input: FrameworkParseInput): Promise<NormalizedFailure[]> {
  const normalized = normalizeFrameworkId(input.framework);
  if (!normalized) return [];
  const adapter = adapters.get(normalized);
  if (!adapter) return [];
  if (!adapter.canParse({
    framework: normalized,
    files: input.files,
    metadata: input.metadata,
    rawReport: input.rawReport,
  })) {
    return [];
  }
  return adapter.parseFailures({
    ...input,
    framework: normalized,
  });
}
