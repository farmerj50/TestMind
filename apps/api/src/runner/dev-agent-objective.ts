// Objective preservation for Autonomous Dev Mode.
//
// A passing test command proves the test RAN; it does not prove the test still checks
// what the user asked for. A repair loop under pressure to go green can quietly swap the
// asserted element ("Get Started" -> "Continue with Email"), negate it, or skip the test.
// This module extracts what each expect(...) in a generated test actually asserts and
// decides - deterministically, not by trusting the model - whether the final test is
// still aligned with the original instruction. The worker only reports `succeeded` when
// BOTH the test command passed AND this check says aligned.

export type AssertionTarget = { text: string; negated: boolean };

export type ObjectiveCheck =
  | { aligned: true; reason: string; targets: AssertionTarget[] }
  | { aligned: false; reason: string; targets: AssertionTarget[] };

export const TEST_FILE_PATTERN = /\.(spec|test)\.[cm]?[jt]sx?$/i;

// Locator/matcher functions whose string/regex argument is user-visible text.
const TEXT_LOCATOR_FNS = ["getByText", "getByLabel", "getByPlaceholder", "getByAltText", "getByTitle"];
const TEXT_MATCHERS = new Set(["toHaveText", "toContainText", "toHaveTitle", "toHaveValue", "toHaveAccessibleName"]);
// Matchers that assert ABSENCE when used without .not (and presence with .not).
const ABSENCE_MATCHERS = new Set(["toBeHidden", "toBeDetached"]);
const SKIP_MARKER = /\b(?:test|it|describe|qe)(?:\.describe)?\.(?:skip|fixme|fail)\s*\(/;
const NEGATION_WORDS = /\b(not|no longer|hidden|absent|missing|removed|disappear\w*|without)\b/i;

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[\s;{}])\/\/.*$/gm, "$1");
}

// Returns the substring inside balanced parens starting at src[openIdx] === "(".
function balanced(src: string, openIdx: number): { inner: string; end: number } | null {
  let depth = 0;
  let quote: string | null = null;
  for (let i = openIdx; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === "\\") { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue; }
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return { inner: src.slice(openIdx + 1, i), end: i };
    }
  }
  return null;
}

function regexSourceToText(source: string): string {
  return source.replace(/\\[sbdwSBDW]/g, " ").replace(/\\(.)/g, "$1").replace(/[\^$.*+?()[\]{}|]/g, " ");
}

// First string/regex literal in an argument list.
function firstLiteral(args: string): string | null {
  const m = /^\s*(?:(["'`])((?:\\.|(?!\1).)*)\1|\/((?:\\.|[^/])+)\/[a-z]*)/.exec(args);
  if (!m) return null;
  return m[2] !== undefined ? m[2] : regexSourceToText(m[3]);
}

function textsFromExpression(expr: string): string[] {
  const out: string[] = [];
  // CSS/Playwright selector text engines inside locator('...') strings.
  for (const m of expr.matchAll(/(?:has-text|:text(?:-is)?)\(\s*(["'])((?:\\.|(?!\1).)*)\1\s*\)/g)) out.push(m[2]);
  for (const m of expr.matchAll(/\btext=(["']?)([^"'\])]+)\1/g)) out.push(m[2]);
  for (const fn of TEXT_LOCATOR_FNS) {
    for (const m of expr.matchAll(new RegExp(`\\b${fn}\\(`, "g"))) {
      const b = balanced(expr, m.index! + fn.length);
      const lit = b && firstLiteral(b.inner);
      if (lit) out.push(lit);
    }
  }
  for (const m of expr.matchAll(/\bgetByRole\(/g)) {
    const b = balanced(expr, m.index! + "getByRole".length);
    const name = b && /\bname\s*:\s*((["'`])(?:\\.|(?!\2).)*\2|\/(?:\\.|[^/])+\/[a-z]*)/.exec(b.inner);
    const lit = name && firstLiteral(name[1]);
    if (lit) out.push(lit);
  }
  // locator(...).filter({ hasText: 'X' }) / locator(sel, { hasText: 'X' }) - text the locator must contain.
  for (const m of expr.matchAll(/\bhasText\s*:\s*((["'`])(?:\\.|(?!\2).)*\2|\/(?:\\.|[^/])+\/[a-z]*)/g)) {
    const lit = firstLiteral(m[1]);
    if (lit) out.push(lit);
  }
  return out;
}

// Resolves `const x = <expr>;` chains so `expect(x)` sees the locator x was built from.
function resolveIdentifiers(expr: string, vars: Map<string, string>, depth = 0): string {
  if (depth > 5) return expr;
  return expr.replace(/\b([A-Za-z_$][\w$]*)\b/g, (name) => {
    const v = vars.get(name);
    return v !== undefined ? `(${resolveIdentifiers(v, vars, depth + 1)})` : name;
  });
}

export function extractAssertionTargets(source: string): AssertionTarget[] {
  const src = stripComments(source);
  const vars = new Map<string, string>();
  for (const m of src.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]+)/g)) vars.set(m[1], m[2]);

  const targets: AssertionTarget[] = [];
  for (const m of src.matchAll(/\bexpect(?:\.soft)?\s*\(/g)) {
    const arg = balanced(src, m.index! + m[0].length - 1);
    if (!arg) continue;
    const chain = /^\s*((?:\.\s*not\s*)?)\.\s*(\w+)\s*\(/.exec(src.slice(arg.end + 1));
    if (!chain) continue;
    const matcher = chain[2];
    const notFlag = chain[1].includes("not");
    const matcherArgs = balanced(src, arg.end + 1 + chain[0].length - 1)?.inner ?? "";
    const countZero = matcher === "toHaveCount" && /^\s*0\s*$/.test(matcherArgs);
    const negated = ABSENCE_MATCHERS.has(matcher) || countZero ? !notFlag : notFlag;

    const texts = textsFromExpression(resolveIdentifiers(arg.inner, vars));
    if (TEXT_MATCHERS.has(matcher)) {
      const lit = firstLiteral(matcherArgs);
      if (lit) texts.push(lit);
    }
    for (const text of texts) if (normalize(text)) targets.push({ text, negated });
  }
  return targets;
}

export function hasSkipMarker(source: string): boolean {
  return SKIP_MARKER.test(stripComments(source));
}

export function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function mentionedIn(instruction: string, text: string): boolean {
  const t = normalize(text);
  return t.length > 0 && ` ${normalize(instruction)} `.includes(` ${t} `);
}

export function checkObjectiveAlignment(opts: {
  instructionText: string | null;
  // Positive targets asserted by the FIRST generated version of the tests (before any
  // repair pressure), or null if no earlier iteration recorded any.
  originalTargets: AssertionTarget[] | null;
  // Final contents of every test file the agent created/modified; null content = deleted.
  finalTestFiles: Array<{ path: string; content: string | null }>;
}): ObjectiveCheck {
  if (opts.finalTestFiles.length === 0) {
    return { aligned: true, reason: "No test files were created or modified by the agent; the configured test command is the verification.", targets: [] };
  }
  const deleted = opts.finalTestFiles.filter((f) => f.content === null).map((f) => f.path);
  if (deleted.length) return { aligned: false, reason: `Agent deleted test file(s): ${deleted.join(", ")}`, targets: [] };

  const skipped = opts.finalTestFiles.filter((f) => hasSkipMarker(f.content!)).map((f) => f.path);
  const targets = opts.finalTestFiles.flatMap((f) => extractAssertionTargets(f.content!));
  if (skipped.length) return { aligned: false, reason: `Test(s) are skipped/fixme/expected-fail, so a pass proves nothing: ${skipped.join(", ")}`, targets };

  const instruction = opts.instructionText ?? "";
  const positive = targets.filter((t) => !t.negated);
  const positiveKeys = new Set(positive.map((t) => normalize(t.text)));

  // Repairs must not drop what the first version checked (only instruction-named targets
  // when there is an instruction - incidental first-draft assertions may be refined).
  const mustKeep = (opts.originalTargets ?? []).filter((t) => !t.negated && (!instruction || mentionedIn(instruction, t.text)));
  const dropped = [...new Set(mustKeep.map((t) => t.text))].filter((text) => !positiveKeys.has(normalize(text)));
  if (dropped.length) {
    const now = positive.map((t) => `"${t.text}"`).join(", ") || "(none)";
    return { aligned: false, reason: `Repair changed the test objective: originally asserted ${dropped.map((d) => `"${d}"`).join(", ")}, final test asserts ${now}. The requested element may not exist on the target - reported as unable to verify rather than substituting another feature.`, targets };
  }

  if (instruction) {
    const instructionNegates = NEGATION_WORDS.test(instruction);
    const invertedTargets = targets.filter((t) => t.negated && mentionedIn(instruction, t.text) && !instructionNegates);
    if (invertedTargets.length) {
      return { aligned: false, reason: `Final test asserts the requested target is ABSENT (${invertedTargets.map((t) => `"${t.text}"`).join(", ")}), inverting the instruction.`, targets };
    }
    // An absence assertion counts as checking the objective only when the instruction asks for absence.
    const grounded = targets.filter((t) => mentionedIn(instruction, t.text) && (!t.negated || instructionNegates));
    if (grounded.length === 0) {
      const now = positive.map((t) => `"${t.text}"`).join(", ") || "(no text-based assertions found)";
      return { aligned: false, reason: `No assertion in the final test checks anything named in the instruction (asserted: ${now}). Unable to verify the requested objective.`, targets };
    }
    return { aligned: true, reason: `Final test asserts instruction target(s): ${[...new Set(grounded.map((t) => `"${t.text}"`))].join(", ")}`, targets };
  }

  return { aligned: true, reason: "No instruction text; original assertions preserved.", targets };
}
