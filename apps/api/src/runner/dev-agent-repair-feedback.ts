import os from "node:os";
import { summarizeTestFailure } from "./dev-agent-test-command.js";

// Repair feedback for the next Dev Agent iteration: the actual test failure (error, locator,
// expected/received, location, code frame, stack), without TestMind's own setup notices or
// temporary paths, plus a signature to detect a failure that repeats unchanged.

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
const NOTICE = /^(Added minimal Playwright test setup|Auto-detected:|\$ )/;
const ARTIFACT_LINE = /tm-dev-agent-pw-output|<tmp>\/|^\s*(Error Context:|attachment #\d+|Usage:\s*$)|playwright show-trace/;
const FAILURE_HEADER = /^\s*\d+\)\s+\S/;
const RUN_SUMMARY = /^\s*\d+\s+(failed|passed|flaky|skipped|did not run|interrupted)\b/;
const FAILURE_START = /^\s*(\w*Error\b.*:|Error:|Test timeout of|No tests found|.*Executable doesn't exist|.*Cannot find module)/;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Test output without TestMind's setup/command lines and with temporary/worktree paths hidden. */
export function cleanTestOutput(output: string | null | undefined, opts: { worktreePath?: string | null } = {}): string {
  let text = String(output ?? "").replace(ANSI, "");
  const roots = [opts.worktreePath, os.tmpdir()].filter((p): p is string => !!p);
  for (const root of roots) {
    for (const variant of new Set([root, root.replace(/\\/g, "/")])) {
      text = text.replace(new RegExp(`${escapeRe(variant)}[\\\\/]?`, "g"), root === opts.worktreePath ? "" : "<tmp>/");
    }
  }
  return text
    .split(/\r?\n/)
    // Artifact pointers (error context, traces) live in the run's temporary output folder and
    // are useless to the model; separator rules are decoration.
    .filter((l) => !NOTICE.test(l) && !ARTIFACT_LINE.test(l) && !/^\s*─{3,}\s*$/.test(l))
    .map((l) => l.replace(/\s*─{3,}\s*$/, ""))
    .join("\n")
    .trim();
}

/**
 * The first failing test's full failure block from the Playwright list reporter (title, error,
 * locator, expected/received, call log, code frame, stack location). Falls back to the first error
 * and what follows it, then to the end of the output.
 */
export function extractFailureDetail(output: string | null | undefined, opts: { worktreePath?: string | null; maxChars?: number } = {}): string | null {
  const max = opts.maxChars ?? 2000;
  const lines = cleanTestOutput(output, opts).split("\n");
  let block: string[];
  const head = lines.findIndex((l) => FAILURE_HEADER.test(l));
  if (head >= 0) {
    const end = lines.findIndex((l, i) => i > head && (FAILURE_HEADER.test(l) || RUN_SUMMARY.test(l)));
    block = lines.slice(head, end > head ? end : undefined);
  } else {
    const start = lines.findIndex((l) => FAILURE_START.test(l));
    block = start >= 0 ? lines.slice(start, start + 30) : lines.slice(-30);
  }
  const text = block.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max)}\n...[truncated]` : text;
}

/** Normalized failure identity: same error, locator and expectation, ignoring timings and line numbers. */
export function failureSignature(output: string | null | undefined): string | null {
  const s = summarizeTestFailure(cleanTestOutput(output));
  if (!s) return null;
  return s
    .replace(/\(\d+(\.\d+)?m?s\)/g, "")
    .replace(/:\d+(:\d+)?/g, "")
    .replace(/\b\d+(\.\d+)?\s*m?s\b/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}
