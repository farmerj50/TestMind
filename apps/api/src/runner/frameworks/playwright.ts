import fs from "node:fs/promises";
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

const extractCallLog = (raw?: string | null) => {
  if (!raw) return { message: raw ?? null, steps: [] as string[] };
  const idx = raw.indexOf("Call log:");
  if (idx < 0) return { message: raw, steps: [] };
  const message = raw.slice(0, idx).trim();
  const steps = raw
    .slice(idx + "Call log:".length)
    .split("\n")
    .map((line) => line.replace(/^\s*[-*]+\s*/, "").trim())
    .filter(Boolean);
  return { message: message || null, steps };
};

const collectIo = (chunks?: any[]): string[] =>
  (chunks || [])
    .map((entry) => {
      if (typeof entry === "string") return entry;
      if (entry?.text) return entry.text;
      return "";
    })
    .map((line) => line.replace(/\r/g, "").trim())
    .filter(Boolean);

function normalizeStatus(value?: string) {
  if (value === "expected" || value === "passed" || value === "flaky") return "passed" as const;
  if (value === "skipped") return "skipped" as const;
  if (value === "failed" || value === "unexpected") return "failed" as const;
  return "failed" as const;
}

function inferFailureKind(message?: string | null, steps: string[] = []): FailureKind {
  const raw = `${message ?? ""}\n${steps.join("\n")}`.toLowerCase();
  if (!raw.trim()) return "unknown";
  if (/getby|locator\(|tobevisible|waiting for/.test(raw)) return "locator";
  if (/page\.goto|tohaveurl|navigation/.test(raw)) return "navigation";
  if (/timeout|timed out|exceeded/.test(raw)) return "timeout";
  if (/net::|connection refused|socket hang up|econn|dns|network/.test(raw)) return "network";
  if (/\b401\b|\b403\b|unauthorized|forbidden|auth/.test(raw)) return "auth";
  if (/\b4\d\d\b|\b5\d\d\b|status code|response status/.test(raw)) return "http";
  if (/env|baseurl|process\.env|undefined/.test(raw)) return "env";
  if (/expected|received|toequal|tomatch|assert/.test(raw)) return "assertion";
  if (/typeerror|referenceerror|syntaxerror|cannot read|is not a function|crash/.test(raw)) {
    return "crash";
  }
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

function normalizeArtifactType(attachment: {
  name?: string;
  path?: string;
  contentType?: string;
}): NormalizedFailureArtifact["type"] | null {
  const raw = `${attachment.name ?? ""} ${attachment.path ?? ""} ${attachment.contentType ?? ""}`.toLowerCase();
  if (!raw.trim()) return null;
  if (raw.includes("screenshot") || raw.endsWith(".png") || raw.endsWith(".jpg") || raw.endsWith(".jpeg")) {
    return "screenshot";
  }
  if (raw.includes("video") || raw.endsWith(".webm") || raw.endsWith(".mp4")) return "video";
  if (raw.includes("trace") || raw.endsWith(".zip")) return "trace";
  if (raw.includes("json") || raw.endsWith(".json")) return "json";
  return "log";
}

function normalizeArtifacts(attachments?: any[]): NormalizedFailureArtifact[] {
  return (attachments || [])
    .map((attachment) => {
      const type = normalizeArtifactType(attachment ?? {});
      if (!type) return null;
      return {
        type,
        path: attachment?.path,
        label: attachment?.name,
      } satisfies NormalizedFailureArtifact;
    })
    .filter((value): value is NormalizedFailureArtifact => Boolean(value));
}

function normalizeTitlePath(parts: string[]) {
  const cleaned = parts.filter(Boolean);
  if (cleaned.length > 1 && cleaned[cleaned.length - 1] === "test") {
    cleaned.pop();
  }
  return cleaned;
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

export const playwrightFailureAdapter: FrameworkFailureAdapter = {
  framework: "playwright-ts",
  canParse({ framework, rawReport }) {
    if (framework !== "playwright-ts") return false;
    if (!rawReport) return true;
    return Boolean((rawReport as any)?.suites || (rawReport as any)?.errors);
  },
  async parseFailures(input) {
    const raw = await loadRawReport(input.resultsPath, input.rawReport);
    if (!raw || (!Array.isArray((raw as any).suites) && !Array.isArray((raw as any).errors))) {
      return [];
    }

    const out: NormalizedFailure[] = [];

    const pushFailure = (payload: {
      file?: string;
      line?: number;
      column?: number;
      suiteName?: string;
      testName: string;
      status: "failed" | "passed" | "skipped";
      message?: string | null;
      stack?: string | null;
      steps?: string[];
      attachments?: any[];
      raw?: Record<string, unknown>;
    }) => {
      const kind = inferFailureKind(payload.message, payload.steps ?? []);
      out.push({
        framework: "playwright-ts",
        runId: input.runId,
        status: payload.status,
        suiteName: payload.suiteName,
        testName: payload.testName,
        message: payload.message ?? undefined,
        stack: payload.stack ?? undefined,
        kind,
        location: {
          file: payload.file,
          testFile: payload.file,
          line: payload.line,
          column: payload.column,
          stepText: payload.steps?.[0],
        },
        artifacts: normalizeArtifacts(payload.attachments),
        suggestedPatchTargets: suggestedPatchTargets(kind),
        raw: payload.raw,
      });
    };

    const walkSuite = (suite: any, ancestors: string[] = []) => {
      const nextAncestors = suite?.title ? [...ancestors, suite.title] : ancestors;
      const suiteName = nextAncestors.length ? nextAncestors.join(" > ") : undefined;

      for (const test of suite.tests || []) {
        const last = (test.results || []).slice(-1)[0] || {};
        const status = normalizeStatus(test.outcome || last.status || (last.error ? "failed" : undefined));
        const rawMessage = stripAnsi(last.error?.message || last.error?.stack || null);
        const { message, steps } = extractCallLog(rawMessage || undefined);
        const titlePath = normalizeTitlePath(
          Array.isArray(test.titlePath) && test.titlePath.length ? test.titlePath : [test.title || "test"]
        );
        pushFailure({
          file: normalizePath(test.location?.file || suite.file),
          line: test.location?.line,
          column: test.location?.column,
          suiteName,
          testName: titlePath[titlePath.length - 1] || "test",
          status,
          message,
          stack: rawMessage,
          steps,
          attachments: last.attachments || test.attachments || [],
          raw: {
            titlePath,
            durationMs: last.duration,
            steps,
            stdout: collectIo(last.stdout),
            stderr: collectIo(last.stderr),
          },
        });
      }

      for (const spec of suite.specs || []) {
        const file = normalizePath(spec.file || suite.file);
        for (const test of spec.tests || []) {
          const last = (test.results || []).slice(-1)[0] || {};
          const status = normalizeStatus(test.outcome || test.status || last.status || (last.error ? "failed" : undefined));
          const rawMessage = stripAnsi(last.error?.message || last.error?.stack || null);
          const { message, steps } = extractCallLog(rawMessage || undefined);
          const titlePath = normalizeTitlePath(
            Array.isArray(test.titlePath) && test.titlePath.length
              ? test.titlePath
              : [spec.title || test.title || "test"].filter(Boolean)
          );
          pushFailure({
            file,
            line: test.location?.line || spec.line,
            column: test.location?.column || spec.column,
            suiteName,
            testName: titlePath[titlePath.length - 1] || "test",
            status,
            message: message ?? stripAnsi(spec.errors?.[0]?.message || null),
            stack: rawMessage,
            steps,
            attachments: last.attachments || test.attachments || spec.attachments || [],
            raw: {
              titlePath,
              durationMs: last.duration,
              steps,
              stdout: collectIo(last.stdout),
              stderr: collectIo(last.stderr),
            },
          });
        }
      }

      for (const child of suite.suites || []) walkSuite(child, nextAncestors);
    };

    for (const suite of (raw as any).suites || []) {
      walkSuite(suite);
    }

    if (!out.length && Array.isArray((raw as any).errors)) {
      for (const err of (raw as any).errors) {
        const message = stripAnsi(err.message || null);
        const kind = inferFailureKind(message);
        out.push({
          framework: "playwright-ts",
          runId: input.runId,
          status: "failed",
          testName: message || "Playwright error",
          message: message ?? undefined,
          stack: stripAnsi(err.stack || null) ?? undefined,
          kind,
          location: {
            file: normalizePath(err.location?.file || err.file),
            line: err.location?.line,
            column: err.location?.column,
            testFile: normalizePath(err.location?.file || err.file),
          },
          artifacts: [],
          suggestedPatchTargets: suggestedPatchTargets(kind),
          raw: {
            name: err.name,
          },
        });
      }
    }

    return out;
  },
};
