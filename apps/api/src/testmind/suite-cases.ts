// Parses test cases out of a suite spec's ACTUAL source for the Suites page.
//
// Playwright tests are usually declared with `test(...)`, but fixture-extended test objects
// (`const qe = base.extend(...)`, or one imported from a fixtures module, as the Autonomous QE
// generator emits) are just as executable. Each case also lists the real statements in its body
// (actions, assertions, objective comments) - nothing is inferred from file names or metadata.

export type SuiteCaseStep = { line: number; kind: "action" | "assertion" | "objective"; text: string };
export type SuiteCase = { title: string; line: number; scenarioId?: string; objective?: string; steps?: SuiteCaseStep[] };

const IDENT = /^[A-Za-z_$][\w$]*$/;
const MAX_STEPS = 40;
const MAX_STEP_TEXT = 240;

/** Identifiers that may be Playwright test functions in this file, besides `test` / `it`. */
function testFunctionAliases(source: string): Set<string> {
  const aliases = new Set<string>();
  // const qe = base.extend<...>({ ... })  /  const myTest = test.extend(...)
  for (const m of source.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[A-Za-z_$][\w$]*\.extend\b/g)) aliases.add(m[1]);
  // import { qe, expect } from './fixtures'  /  import { test as base } from '@playwright/test'
  for (const m of source.matchAll(/import\s*(?:type\s+)?\{([^}]*)\}\s*from\s*['"][^'"]+['"]/g)) {
    for (const part of m[1].split(",")) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim() ?? "";
      if (IDENT.test(name) && name !== "test" && name !== "it") aliases.add(name);
    }
  }
  return aliases;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Body lines of the test whose declaration starts at `startIdx` (brace-balanced, strings skipped). */
function testBody(lines: string[], startIdx: number): Array<{ line: number; text: string }> {
  let depth = 0;
  let opened = false;
  const out: Array<{ line: number; text: string }> = [];
  for (let i = startIdx; i < lines.length; i++) {
    const text = lines[i];
    let quote: string | null = null;
    for (let j = 0; j < text.length; j++) {
      const ch = text[j];
      if (quote) {
        if (ch === "\\") { j++; continue; }
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === "/" && text[j + 1] === "/") break; // line comment
      if (ch === "'" || ch === '"' || ch === "`") { quote = ch; continue; }
      if (ch === "{") { depth++; opened = true; }
      else if (ch === "}") depth--;
    }
    if (i > startIdx) out.push({ line: i + 1, text });
    if (opened && depth <= 0) break;
  }
  return out;
}

function stepsFor(body: Array<{ line: number; text: string }>): { steps: SuiteCaseStep[]; objective?: string } {
  const steps: SuiteCaseStep[] = [];
  let objective: string | undefined;
  for (const { line, text } of body) {
    const t = text.trim();
    const obj = /^\/\/\s*(?:Objective|Expected)\s*:\s*(.+)$/i.exec(t);
    if (obj) {
      objective ??= obj[1].trim();
      steps.push({ line, kind: "objective", text: obj[1].trim().slice(0, MAX_STEP_TEXT) });
    } else if (/^(?:await\s+)?expect(?:\.\w+)?\s*\(/.test(t)) {
      steps.push({ line, kind: "assertion", text: t.slice(0, MAX_STEP_TEXT) });
    } else if (/^await\s+/.test(t)) {
      steps.push({ line, kind: "action", text: t.slice(0, MAX_STEP_TEXT) });
    }
    if (steps.length >= MAX_STEPS) break;
  }
  return { steps, objective };
}

export function parseSuiteCases(relPath: string, source: string): SuiteCase[] {
  const normalizedPath = relPath.replace(/\\/g, "/").toLowerCase();
  const lines = source.split(/\r?\n/);
  if (normalizedPath.endsWith(".feature")) {
    const out: SuiteCase[] = [];
    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(/^\s*Scenario(?: Outline)?:\s*(.+?)\s*$/i);
      if (match?.[1]) out.push({ title: match[1].trim(), line: i + 1 });
    }
    return out;
  }

  // `test` / `it`: unchanged, lenient rule (existing specs may use non-async callbacks).
  const caseRe = /\b(?:test|it)(?:\.(?:only|skip))?\s*\(\s*['""`]([^'""`]+)['""`]\s*,/g;
  // Aliases (e.g. `qe`) must look like a real test call: a title followed by an async callback
  // (optionally after a details object), so helpers such as traceScenario("id", []) never match.
  const aliases = [...testFunctionAliases(source)];
  const aliasRe = aliases.length
    ? new RegExp(`(?:^|[^\\w$.])(?:${aliases.map(escapeRe).join("|")})(?:\\.(?:only|skip|fixme|fail|slow))?\\s*\\(\\s*(['"\`])((?:\\\\.|(?!\\1).)+)\\1\\s*,\\s*(?:\\{[^{}]*\\}\\s*,\\s*)?async\\b`, "g")
    : null;

  const out: SuiteCase[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const titles: string[] = [];
    let match: RegExpExecArray | null;
    caseRe.lastIndex = 0;
    while ((match = caseRe.exec(line))) titles.push(match[1]);
    if (aliasRe) {
      aliasRe.lastIndex = 0;
      while ((match = aliasRe.exec(line))) {
        const raw = match[2];
        let title = raw;
        try { if (match[1] === '"') title = JSON.parse(`"${raw}"`); } catch { /* keep raw */ }
        titles.push(title.replace(/\\(['`])/g, "$1"));
      }
    }
    for (const title of titles) {
      const scenarioId = /\[qe:([A-Za-z0-9_-]+)\]/.exec(title)?.[1];
      const { steps, objective } = stepsFor(testBody(lines, i));
      out.push({ title, line: i + 1, ...(scenarioId ? { scenarioId } : {}), ...(objective ? { objective } : {}), ...(steps.length ? { steps } : {}) });
    }
  }
  return out;
}

/** True when the source declares at least one test case (any recognized test function). */
export function hasSuiteCases(relPath: string, source: string): boolean {
  return parseSuiteCases(relPath, source).length > 0;
}
