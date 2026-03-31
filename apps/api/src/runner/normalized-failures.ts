import { getFrameworkAdapter, parseNormalizedFailures } from "./frameworks/registry.js";
import type { FrameworkParseInput, NormalizedFailure } from "./frameworks/types.js";
import { normalizeFrameworkId } from "./frameworks/types.js";

export type NormalizedFailureSet = {
  framework: string;
  adapterFound: boolean;
  failures: NormalizedFailure[];
  failed: NormalizedFailure[];
};

export async function loadNormalizedFailures(input: FrameworkParseInput): Promise<NormalizedFailureSet> {
  const normalizedFramework = normalizeFrameworkId(input.framework) ?? String(input.framework);
  const adapter = typeof normalizedFramework === "string" ? getFrameworkAdapter(normalizedFramework) : null;
  const failures = await parseNormalizedFailures(input);
  return {
    framework: normalizedFramework,
    adapterFound: Boolean(adapter),
    failures,
    failed: failures.filter((failure) => failure.status === "failed"),
  };
}

export function groupNormalizedFailuresByFile(failures: NormalizedFailure[]) {
  return failures.reduce<Record<string, NormalizedFailure[]>>((acc, failure) => {
    const key =
      failure.location.testFile ||
      failure.location.file ||
      failure.location.sourceFile ||
      "unknown";
    (acc[key] ||= []).push(failure);
    return acc;
  }, {});
}

export function summarizeNormalizedFailure(failure: NormalizedFailure) {
  return {
    framework: failure.framework,
    status: failure.status,
    kind: failure.kind,
    testName: failure.testName,
    suiteName: failure.suiteName,
    file: failure.location.testFile || failure.location.file || failure.location.sourceFile,
    message: failure.message ?? null,
    artifacts: failure.artifacts.map((artifact) => ({
      type: artifact.type,
      path: artifact.path ?? null,
      label: artifact.label ?? null,
    })),
  };
}
