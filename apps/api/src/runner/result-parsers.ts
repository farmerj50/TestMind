import fs from "fs/promises";

export type ParsedCase = {
  file: string;
  fullName: string;     // runner's full title
  durationMs?: number;
  status: "passed" | "failed" | "skipped" | "error";
  message?: string | null;
};

export async function parseResults(resultsPath: string): Promise<ParsedCase[]> {
  let raw: any;
  try {
    raw = JSON.parse(await fs.readFile(resultsPath, "utf8"));
  } catch {
    return [];
  }

  // JEST FORMAT
  if (Array.isArray(raw.testResults)) {
    const out: ParsedCase[] = [];
    for (const tr of raw.testResults) {
      const file = tr.name || tr.testFilePath || "unknown";
      for (const a of tr.assertionResults || []) {
        const status = a.status === "passed" ? "passed" :
                       a.status === "failed" ? "failed" : "skipped";
        const msg = (a.failureMessages || []).join("\n") || null;
        out.push({
          file,
          fullName: a.fullName || a.title,
          durationMs: a.duration || undefined,
          status,
          message: msg,
        });
      }
    }
    return out;
  }

  // VITEST (json reporter)
  if (Array.isArray(raw)) {
    // vitest json reporter often outputs an array of suites
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
          file: node.file || fileHint || node.location?.file || "unknown",
          fullName: node.namePath?.join(" ") || node.name || "test",
          durationMs: node.result?.duration,
          status,
          message: node.result?.error?.message || null,
        });
      }
    };
    raw.forEach((n: any) => walk(n));
    return out;
  }
    // PLAYWRIGHT (json reporter)
  if (raw && Array.isArray(raw.suites)) {
    const out: ParsedCase[] = [];
    const walk = (suite: any) => {
      for (const t of suite.tests || []) {
        const last = (t.results || []).slice(-1)[0] || {};
        const status =
          t.outcome || last.status || (last.error ? "failed" : "passed");
        out.push({
          file: t.location?.file || "unknown",
          fullName: t.titlePath ? t.titlePath.join(" › ") : t.title,
          durationMs: last.duration,
          status: status === "expected" ? "passed"
                : status === "skipped" ? "skipped"
                : status === "flaky" ? "passed"
                : status as any,
          message: last.error?.message || null,
        });
      }
      for (const s of suite.suites || []) walk(s);
    };
    raw.suites.forEach(walk);
    return out;
  }


  return [];
}

