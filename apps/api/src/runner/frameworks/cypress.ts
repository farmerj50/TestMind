import fs from "node:fs/promises";
import path from "node:path";
import type {
  FailureKind,
  FrameworkFailureAdapter,
  NormalizedFailure,
  NormalizedFailureArtifact,
  PatchTargetKind,
} from "./types.js";

const normalizePath = (value?: string | null) =>
  (value ?? "unknown").replace(/\\/g, "/");

const stripAnsi = (value?: string | null) => {
  if (!value) return value ?? null;
  return value.replace(/\u001B\[[0-9;]*[A-Za-z]/g, "").replace(/\r/g, "").trim();
};

function inferFailureKind(message?: string | null): FailureKind {
  const raw = (message ?? "").toLowerCase();
  if (!raw.trim()) return "unknown";
  if (/cy\.get|cy\.contains|selector|element not found|timed out retrying/.test(raw)) return "locator";
  if (/cy\.visit|navigation|redirect|url/.test(raw)) return "navigation";
  if (/timeout|timed out|exceeded/.test(raw)) return "timeout";
  if (/network|xhr|fetch|socket|econn|dns|net::/.test(raw)) return "network";
  if (/\b401\b|\b403\b|unauthorized|forbidden|auth/.test(raw)) return "auth";
  if (/\b4\d\d\b|\b5\d\d\b|status code|response status/.test(raw)) return "http";
  if (/env|baseurl|process\.env|undefined/.test(raw)) return "env";
  if (/expected|received|assert|deep equal|to equal/.test(raw)) return "assertion";
  if (/typeerror|referenceerror|syntaxerror|cannot read|is not a function|crash/.test(raw)) return "crash";
  return "unknown";
}

function suggestedPatchTargets(kind: FailureKind): PatchTargetKind[] {
  switch (kind) {
    case "locator":
      return ["spec", "test-helper"];
    case "navigation":
      return ["spec", "config"];
    case "timeout":
      return ["spec", "test-helper", "config"];
    case "assertion":
      return ["spec", "source"];
    case "network":
      return ["environment", "config", "source"];
    case "http":
      return ["source", "config", "environment"];
    case "auth":
      return ["environment", "config", "source"];
    case "env":
      return ["environment", "config"];
    case "crash":
      return ["source", "spec"];
    default:
      return ["unknown"];
  }
}

function normalizeArtifactType(filePath: string): NormalizedFailureArtifact["type"] | null {
  const raw = filePath.toLowerCase();
  if (raw.endsWith(".png") || raw.endsWith(".jpg") || raw.endsWith(".jpeg")) return "screenshot";
  if (raw.endsWith(".webm") || raw.endsWith(".mp4")) return "video";
  if (raw.endsWith(".zip")) return "trace";
  if (raw.endsWith(".json")) return "json";
  return null;
}

function sanitizeToken(value?: string | null) {
  return (value ?? "")
    .toLowerCase()
    .replace(/\\/g, "/")
    .replace(/\.(cy|spec)\.[^/.]+$/i, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function splitSuiteName(fullTitle: string, title: string) {
  if (!fullTitle) return undefined;
  if (!title) return fullTitle || undefined;
  if (fullTitle === title) return undefined;
  if (fullTitle.endsWith(title)) {
    return fullTitle.slice(0, Math.max(0, fullTitle.length - title.length)).trim() || undefined;
  }
  return fullTitle;
}

async function loadRawReport(resultsPath?: string, rawReport?: unknown) {
  if (rawReport) return rawReport;
  if (!resultsPath) return null;
  try {
    return JSON.parse(await fs.readFile(resultsPath, "utf8"));
  } catch {
    return null;
  }
}

function collectArtifactCandidates(input: {
  files?: string[];
  metadata?: Record<string, unknown>;
  resultsPath?: string;
}) {
  const out = new Set<string>();
  for (const value of input.files || []) {
    if (typeof value === "string") out.add(normalizePath(value));
  }
  const metadataFiles = input.metadata?.artifactFiles;
  if (Array.isArray(metadataFiles)) {
    for (const value of metadataFiles) {
      if (typeof value === "string") out.add(normalizePath(value));
    }
  }
  if (typeof input.resultsPath === "string") {
    const reportDir = path.dirname(path.resolve(input.resultsPath));
    out.add(normalizePath(path.join(reportDir, "cypress", "screenshots")));
    out.add(normalizePath(path.join(reportDir, "cypress", "videos")));
  }
  return [...out];
}

function matchArtifacts(
  files: string[],
  test: { file?: string; title?: string; fullTitle?: string }
): NormalizedFailureArtifact[] {
  const specToken = sanitizeToken(test.file);
  const titleToken = sanitizeToken(test.title || test.fullTitle);
  const fullTitleToken = sanitizeToken(test.fullTitle);

  return files
    .filter((filePath) => {
      const lower = filePath.toLowerCase();
      if (!/(cypress\/screenshots|cypress\/videos)/.test(lower)) return false;
      const compact = sanitizeToken(lower);
      if (specToken && compact.includes(specToken)) return true;
      if (titleToken && compact.includes(titleToken)) return true;
      if (fullTitleToken && compact.includes(fullTitleToken)) return true;
      return false;
    })
    .map((filePath) => {
      const type = normalizeArtifactType(filePath);
      if (!type) return null;
      return {
        type,
        path: filePath,
        label: path.basename(filePath),
      } satisfies NormalizedFailureArtifact;
    })
    .filter((value): value is NormalizedFailureArtifact => Boolean(value));
}

type CypressMochaTest = {
  title?: string;
  fullTitle?: string;
  file?: string;
  duration?: number;
  err?: {
    message?: string;
    stack?: string;
    actual?: unknown;
    expected?: unknown;
  } | null;
  state?: string;
  pending?: boolean;
};

function collectTests(raw: any): Array<{ status: "passed" | "failed" | "skipped"; test: CypressMochaTest }> {
  const out: Array<{ status: "passed" | "failed" | "skipped"; test: CypressMochaTest }> = [];
  const push = (items: unknown, status: "passed" | "failed" | "skipped") => {
    if (!Array.isArray(items)) return;
    for (const item of items) {
      out.push({ status, test: (item ?? {}) as CypressMochaTest });
    }
  };

  push(raw?.passes, "passed");
  push(raw?.failures, "failed");
  push(raw?.pending, "skipped");

  if (!out.length && Array.isArray(raw?.tests)) {
    for (const item of raw.tests as CypressMochaTest[]) {
      const status =
        item.pending || item.state === "pending"
          ? "skipped"
          : item.state === "passed"
          ? "passed"
          : item.state === "failed" || item.err
          ? "failed"
          : "failed";
      out.push({ status, test: item });
    }
  }

  return out;
}

export const cypressFailureAdapter: FrameworkFailureAdapter = {
  framework: "cypress-js",
  canParse({ framework, rawReport, files, metadata }) {
    if (framework !== "cypress-js") return false;
    if (rawReport) {
      const report = rawReport as any;
      return Boolean(report?.stats || report?.tests || report?.failures || report?.passes || report?.pending);
    }
    const artifactFiles = [...(files || []), ...(((metadata?.artifactFiles as unknown[]) || []) as string[])];
    return artifactFiles.some((file) => typeof file === "string" && /cypress/i.test(file));
  },
  async parseFailures(input) {
    const raw = await loadRawReport(input.resultsPath, input.rawReport);
    if (!raw) return [];

    const artifactCandidates = collectArtifactCandidates(input);
    const tests = collectTests(raw);
    const out: NormalizedFailure[] = [];

    for (const { status, test } of tests) {
      const message = stripAnsi(test.err?.message || test.err?.stack || null);
      const kind = status === "failed" ? inferFailureKind(message) : "unknown";
      const fullTitle = test.fullTitle || test.title || "test";
      const title = test.title || fullTitle;
      out.push({
        framework: "cypress-js",
        runId: input.runId,
        status,
        suiteName: splitSuiteName(fullTitle, title),
        testName: title,
        message: message ?? undefined,
        stack: stripAnsi(test.err?.stack || null) ?? undefined,
        kind,
        location: {
          file: normalizePath(test.file),
          testFile: normalizePath(test.file),
        },
        artifacts: matchArtifacts(artifactCandidates, {
          file: test.file,
          title,
          fullTitle,
        }),
        suggestedPatchTargets: status === "failed" ? suggestedPatchTargets(kind) : ["spec"],
        raw: {
          durationMs: test.duration,
          fullTitle,
          actual: test.err?.actual,
          expected: test.err?.expected,
        },
      });
    }

    return out;
  },
};
