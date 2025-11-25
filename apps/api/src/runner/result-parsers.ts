import fs from "fs/promises";

export type ParsedCase = {
  file: string;
  fullName: string;     // runner's full title
  durationMs?: number;
  status: "passed" | "failed" | "skipped" | "error";
  message?: string | null;
  steps?: string[];
  stdout?: string[];
  stderr?: string[];
  attachments?: { name: string; path?: string; contentType?: string }[];
};

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
    .map((line) => line.replace(/^\s*[-•]+\s*/, "").trim())
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

export async function parseResults(resultsPath: string, rawReport?: any): Promise<ParsedCase[]> {
  let raw: any = rawReport;
  if (!raw) {
    try {
      raw = JSON.parse(await fs.readFile(resultsPath, "utf8"));
    } catch {
      return [];
    }
  }

  // JEST FORMAT
  if (Array.isArray(raw.testResults)) {
    const out: ParsedCase[] = [];
    for (const tr of raw.testResults) {
      const file = normalizePath(tr.name || tr.testFilePath);
      for (const a of tr.assertionResults || []) {
        const status = a.status === "passed" ? "passed" :
                       a.status === "failed" ? "failed" : "skipped";
        const msg = (a.failureMessages || []).join("\n") || null;
        out.push({
          file,
          fullName: a.fullName || a.title,
          durationMs: a.duration || undefined,
          status,
          message: stripAnsi(msg),
          steps: [],
          stdout: [],
          stderr: [],
          attachments: [],
        });
      }
    }
    return out;
  }

  // VITEST (json reporter)
  if (Array.isArray(raw)) {
    const out: ParsedCase[] = [];
    const walk = (node: any, fileHint?: string) => {
      if (!node) return;
      if (node.type === "suite" && Array.isArray(node.tasks)) {
        for (const t of node.tasks) walk(t, node.file || fileHint);
      } else if (node.type === "test") {
        const status = node.result?.state === "pass" ? "passed" :
                       node.result?.state === "fail" ? "failed" :
                       node.result?.state === "skip" ? "skipped" : "error";
        out.push({
          file: normalizePath(node.file || fileHint || node.location?.file),
          fullName: node.namePath?.join(" ") || node.name || "test",
          durationMs: node.result?.duration,
          status,
          message: stripAnsi(node.result?.error?.message || null),
          steps: [],
          stdout: [],
          stderr: [],
          attachments: [],
        });
      }
    };
    raw.forEach((n: any) => walk(n));
    return out;
  }

  // PLAYWRIGHT (json reporter)
  if (raw && Array.isArray(raw.suites)) {
    const out: ParsedCase[] = [];
    const normalizeStatus = (value?: string) => {
      if (value === "expected" || value === "passed") return "passed";
      if (value === "skipped") return "skipped";
      if (value === "flaky") return "passed";
      if (value === "failed" || value === "unexpected") return "failed";
      return (value as any) || "error";
    };

    const walkSuite = (suite: any, ancestors: string[] = []) => {
      const nextAncestors = suite?.title ? [...ancestors, suite.title] : ancestors;

      // Legacy PW JSON (tests directly on suite.tests)
      for (const test of suite.tests || []) {
        const last = (test.results || []).slice(-1)[0] || {};
        const status = normalizeStatus(test.outcome || last.status || (last.error ? "failed" : undefined));
        const rawMessage = stripAnsi(last.error?.message || last.error?.stack || null);
        const { message, steps } = extractCallLog(rawMessage || undefined);
        out.push({
          file: normalizePath(test.location?.file || suite.file),
          fullName: test.titlePath?.join(" > ") || [...nextAncestors, test.title || "test"].join(" > "),
          durationMs: last.duration,
          status,
          message,
          steps,
          stdout: collectIo(last.stdout),
          stderr: collectIo(last.stderr),
          attachments: (last.attachments || test.attachments || []).map((a: any) => ({
            name: a?.name,
            path: a?.path,
            contentType: a?.contentType,
          })),
        });
      }

      // Current PW JSON (suite.specs[].tests[])
      for (const spec of suite.specs || []) {
        const titleParts = spec.title ? [...nextAncestors, spec.title] : nextAncestors;
        const file = normalizePath(spec.file || suite.file);
        for (const test of spec.tests || []) {
          const last = (test.results || []).slice(-1)[0] || {};
          const status = normalizeStatus(test.outcome || test.status || last.status || (last.error ? "failed" : undefined));
          const rawMessage = stripAnsi(last.error?.message || last.error?.stack || null);
          const { message, steps } = extractCallLog(rawMessage || undefined);
          out.push({
            file,
            fullName: titleParts.length ? titleParts.join(" > ") : spec.file || "test",
            durationMs: last.duration,
            status,
            message: message ?? stripAnsi(spec.errors?.[0]?.message || null),
            steps,
            stdout: collectIo(last.stdout),
            stderr: collectIo(last.stderr),
            attachments: (last.attachments || test.attachments || spec.attachments || []).map((a: any) => ({
              name: a?.name,
              path: a?.path,
              contentType: a?.contentType,
            })),
          });
        }
      }

      for (const child of suite.suites || []) walkSuite(child, nextAncestors);
    };

    raw.suites.forEach((suite: any) => walkSuite(suite));
    return out;
  }

  return [];
}
