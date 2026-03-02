import type { FastifyInstance } from "fastify";
import { getAuth } from "@clerk/fastify";
import { z } from "zod";
import path from "node:path";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import { prisma } from "../prisma.js";
import { GENERATED_ROOT } from "../lib/storageRoots.js";
import { writeSpecsFromPlan } from "../testmind/pipeline/codegen.js";
import type { Step, TestPlan } from "../testmind/core/plan.js";
import {
  CURATED_ROOT,
  ensureWithin,
  readCuratedManifest,
  slugify,
  writeCuratedManifest,
} from "../testmind/curated-store.js";

const stepLineSchema = z.string().trim().min(1);

const generateSchema = z.object({
  projectId: z.string().min(1),
  title: z.string().trim().min(1),
  steps: z.array(stepLineSchema).min(1),
  notes: z.string().optional(),
  docs: z.array(z.object({ name: z.string(), summary: z.string().optional() })).optional(),
  baseUrl: z.string().optional(),
});

const curateSchema = z.object({
  projectId: z.string().min(1),
  specPath: z.string().min(1),
  curatedName: z.string().optional(),
});

const googleSheetPreviewSchema = z.object({
  url: z.string().url(),
});

const normalizePath = (value: string) => value.replace(/\\/g, "/").replace(/^\/+/, "");

const normalizeGeneratedRelPath = (value: string) => {
  const normalized = normalizePath(value);
  return normalized.startsWith("testmind-generated/")
    ? normalized.slice("testmind-generated/".length)
    : normalized;
};

const filenameFromPagePath = (pagePath: string) => {
  const normalized =
    pagePath.startsWith("/manual/") ? `/${pagePath.slice("/manual/".length)}` : pagePath;
  const safe = normalized === "/" ? "home" : normalized.replace(/\//g, "_").replace(/^_/, "");
  return `${safe || "home"}.spec.ts`;
};

const NAV_EXPECTATION_RE =
  /\b(navigat(?:e|ed|es|ing)|redirect(?:ed|s|ing)?|land(?:ed|s|ing)?|open(?:ed|s|ing)?)\b.*\b(url|page|site|home|homepage)\b/i;

type SharedLoginConfig = {
  usernameSelector?: string;
  passwordSelector?: string;
  submitSelector?: string;
  usernameEnv?: string;
  passwordEnv?: string;
  usernameValue?: string;
  passwordValue?: string;
  postLoginPath?: string;
};

const DEFAULT_SHARED_LOGIN: Required<
  Pick<SharedLoginConfig, "usernameSelector" | "passwordSelector" | "submitSelector" | "usernameEnv" | "passwordEnv">
> = {
  usernameSelector:
    'input[name="email"], input[type="email"], input[autocomplete="username"], input[name="username"], #username, #email, input[placeholder*="email" i]',
  passwordSelector:
    'input[name="password"], input[type="password"], input[autocomplete="current-password"], #password, input[placeholder*="password" i]',
  submitSelector: 'button[type="submit"], button:has-text("Login"), button:has-text("Sign in")',
  usernameEnv: "EMAIL_ADDRESS",
  passwordEnv: "PASSWORD",
};

const extractUrlFromText = (value: string) => {
  const match = value.match(/https?:\/\/[^\s'"`)]+/i);
  if (!match?.[0]) return null;
  return match[0].replace(/[.,;!?]+$/, "");
};

const isNavigationExpectation = (value: string) => NAV_EXPECTATION_RE.test(value);

const resolveSharedLoginConfig = (sharedSteps?: Record<string, any>): SharedLoginConfig => {
  const login = ((sharedSteps ?? {}) as any)?.login ?? {};
  const trim = (v?: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  return {
    usernameSelector: trim(login.usernameSelector) ?? DEFAULT_SHARED_LOGIN.usernameSelector,
    passwordSelector: trim(login.passwordSelector) ?? DEFAULT_SHARED_LOGIN.passwordSelector,
    submitSelector: trim(login.submitSelector) ?? DEFAULT_SHARED_LOGIN.submitSelector,
    usernameEnv: trim(login.usernameEnv) ?? DEFAULT_SHARED_LOGIN.usernameEnv,
    passwordEnv: trim(login.passwordEnv) ?? DEFAULT_SHARED_LOGIN.passwordEnv,
    usernameValue: trim(login.usernameValue),
    passwordValue: trim(login.passwordValue),
    postLoginPath: trim(login.postLoginPath),
  };
};

const parseSharedStepRequests = (preconditions: string[]) => {
  const lower = preconditions.map((p) => p.toLowerCase());
  const named = new Set<string>();
  preconditions.forEach((p) => {
    const matches = p.matchAll(/shared\s*:\s*([a-z0-9_-]+)/gi);
    for (const m of matches) {
      if (m[1]) named.add(m[1].toLowerCase());
    }
  });
  const mentionsLoggedIn = lower.some(
    (p) =>
      /\b(logged in|already logged in|authenticated|authenticated user|use shared login|shared login)\b/i.test(p) &&
      !/\blogged out\b/i.test(p)
  );
  const wantsLogin = mentionsLoggedIn || named.has("login") || named.has("shared-login");
  return { wantsLogin, named: Array.from(named) };
};

const getString = (...values: Array<unknown>) => {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
};

const resolveSharedStepEntry = (sharedSteps: Record<string, any>, rawName: string): unknown => {
  const normalized = rawName.trim().toLowerCase();
  if (!normalized) return undefined;
  const candidates: unknown[] = [];
  const roots = [
    sharedSteps?.shared,
    sharedSteps?.sharedSteps,
    sharedSteps?.functions,
    sharedSteps?.steps,
    sharedSteps?.flows,
    sharedSteps,
  ];
  for (const root of roots) {
    if (!root || typeof root !== "object") continue;
    const map = root as Record<string, unknown>;
    for (const [key, value] of Object.entries(map)) {
      if (key.toLowerCase() === normalized) candidates.push(value);
    }
  }
  return candidates[0];
};

const sharedEntryToLines = (entry: unknown): string[] => {
  if (typeof entry === "string") return [entry.trim()].filter(Boolean);
  if (Array.isArray(entry)) return entry.flatMap((item) => sharedEntryToLines(item));
  if (!entry || typeof entry !== "object") return [];

  const obj = entry as Record<string, any>;
  const list = obj.steps ?? obj.actions ?? obj.items ?? obj.flow;
  if (Array.isArray(list)) return list.flatMap((item: unknown) => sharedEntryToLines(item));

  const lines: string[] = [];
  const action = getString(obj.action, obj.step, obj.command, obj.do);
  const target = getString(obj.selector, obj.locator, obj.url, obj.target);
  const value = getString(obj.value, obj.testData, obj.input, obj.with);
  const expected = getString(obj.expected, obj.assertion, obj.result);
  const note = getString(obj.note, obj.description);

  if (action) {
    const upper = action.toUpperCase();
    if (/(GOTO|NAVIGATE|OPEN)/.test(upper)) {
      if (target) lines.push(target.startsWith("http") || target.startsWith("/") ? target : `go to ${target}`);
    } else if (/(CLICK|TAP|PRESS)/.test(upper)) {
      lines.push(target ? `click ${target}` : "click Continue");
    } else if (/(FILL|TYPE|ENTER)/.test(upper)) {
      if (target && value) lines.push(`fill ${target} = ${value}`);
      else if (target) lines.push(`fill ${target}`);
    } else if (/ASSERT_URL_CONTAINS/.test(upper)) {
      if (target) lines.push(`expect url contains ${target}`);
      else lines.push(action);
    } else if (/ASSERT_URL_NOT_CONTAINS/.test(upper)) {
      if (target) lines.push(`expect url not contains ${target}`);
      else lines.push(action);
    } else {
      lines.push([action, target, value].filter(Boolean).join(" "));
    }
  }
  if (expected) lines.push(`Verify: ${expected}`);
  if (note) lines.push(`// ${note}`);
  return lines;
};

const expandNamedSharedSteps = (sharedSteps: Record<string, any>, names: string[]) => {
  const out: string[] = [];
  for (const name of names) {
    if (!name || name === "login" || name === "shared-login") continue;
    const entry = resolveSharedStepEntry(sharedSteps, name);
    const lines = sharedEntryToLines(entry);
    if (!lines.length) {
      out.push(`// shared:${name} (not found)`);
      continue;
    }
    out.push(`// shared:${name}`);
    out.push(...lines);
  }
  return out;
};

const renderSimplePlaywrightSpec = (
  title: string,
  steps: Step[],
  baseUrl: string,
  options?: { sharedSteps?: Record<string, any>; preconditions?: string[] }
) => {
  const esc = (v: string) => JSON.stringify(v);
  const lines: string[] = [];
  let lastGotoUrl: string | null = null;
  const preconditions = options?.preconditions ?? [];
  const sharedLogin = resolveSharedLoginConfig(options?.sharedSteps);
  const sharedRequests = parseSharedStepRequests(preconditions);

  lines.push("import { test, expect } from '@playwright/test';");
  lines.push("");
  lines.push(`const BASE_URL = ${esc(baseUrl)};`);
  if (sharedRequests.wantsLogin) {
    lines.push(`const SHARED_LOGIN = ${JSON.stringify(sharedLogin, null, 2)};`);
    lines.push("");
    lines.push("async function runSharedLogin(page) {");
    lines.push("  const username = process.env[SHARED_LOGIN.usernameEnv] || SHARED_LOGIN.usernameValue || '';");
    lines.push("  const password = process.env[SHARED_LOGIN.passwordEnv] || SHARED_LOGIN.passwordValue || '';");
    lines.push("  if (username) await page.fill(SHARED_LOGIN.usernameSelector, username);");
    lines.push("  if (password) await page.fill(SHARED_LOGIN.passwordSelector, password);");
    lines.push("  await page.click(SHARED_LOGIN.submitSelector);");
    lines.push("  if (SHARED_LOGIN.postLoginPath) {");
    lines.push("    await expect(page).toHaveURL(new RegExp(SHARED_LOGIN.postLoginPath));");
    lines.push("  }");
    lines.push("}");
    lines.push("");
  }
  lines.push("");
  lines.push(`test(${esc(title)}, async ({ page }) => {`);
  if (sharedRequests.wantsLogin) {
    lines.push("  // Shared-step precondition requested: run login helper.");
    lines.push("  await runSharedLogin(page);");
  }
  if (sharedRequests.named.length > 0) {
    lines.push(`  // Requested shared steps: ${sharedRequests.named.join(", ")}`);
  }
  for (const step of steps) {
    switch (step.kind) {
      case "goto": {
        const raw = step.url;
        lastGotoUrl = raw;
        const isAbs = /^https?:\/\//i.test(raw);
        if (isAbs) {
          lines.push(`  await page.goto(${esc(raw)});`);
        } else {
          lines.push(`  await page.goto(new URL(${esc(raw)}, BASE_URL).toString());`);
        }
        break;
      }
      case "click":
        lines.push(`  await page.click(${esc(step.selector)});`);
        break;
      case "fill":
        lines.push(`  await page.fill(${esc(step.selector)}, ${esc(step.value)});`);
        break;
      case "expect-text":
        {
          const containsMatch = step.text.match(/url\s+contains\s+(.+)$/i);
          if (containsMatch?.[1]) {
            lines.push(`  await expect(page).toHaveURL(new RegExp(${esc(containsMatch[1])}));`);
            break;
          }
          const notContainsMatch = step.text.match(/url\s+not\s+contains\s+(.+)$/i);
          if (notContainsMatch?.[1]) {
            const needle = notContainsMatch[1].trim();
            if (needle === "/login") {
              lines.push("  // Skipped brittle assertion: URL not contains /login");
            } else {
              lines.push(`  await expect(page.url()).not.toContain(${esc(needle)});`);
            }
            break;
          }
          const explicitUrl = extractUrlFromText(step.text);
          if (explicitUrl) {
            lines.push(`  await expect(page).toHaveURL(${esc(explicitUrl)});`);
            break;
          }
          if (isNavigationExpectation(step.text)) {
            if (lastGotoUrl) {
              const isAbs = /^https?:\/\//i.test(lastGotoUrl);
              if (isAbs) {
                lines.push(`  await expect(page).toHaveURL(${esc(lastGotoUrl)});`);
              } else {
                lines.push(`  await expect(page).toHaveURL(new URL(${esc(lastGotoUrl)}, BASE_URL).toString());`);
              }
            } else {
              lines.push("  await expect(page).toHaveURL(BASE_URL);");
            }
            break;
          }
          lines.push(`  await expect(page.getByText(${esc(step.text)})).toBeVisible();`);
        }
        break;
      case "expect-visible":
        lines.push(`  await expect(page.locator(${esc(step.selector)})).toBeVisible();`);
        break;
      case "upload":
        lines.push(`  await page.setInputFiles(${esc(step.selector)}, ${esc(step.path)});`);
        break;
      case "custom":
        if (step.note && /^precondition:/i.test(step.note)) {
          lines.push(`  // ${step.note}`);
        } else {
          lines.push(`  // ${step.note || "Custom step"}`);
        }
        break;
      default:
        lines.push("  // TODO: custom step");
        break;
    }
  }
  lines.push("});");
  return lines.join("\n");
};

const parseStepLine = (line: string): Step => {
  const raw = line.trim();
  const selectorFromTarget = (target: string) => {
    const trimmed = target.trim();
    if (!trimmed) return "text=Continue";
    const lower = trimmed.toLowerCase();
    if (
      /^input/i.test(trimmed) &&
      (/\btype\s*=\s*["']?email["']?/.test(lower) ||
        /\bname\s*=\s*["']?email["']?/.test(lower) ||
        /\bname\s*=\s*["']?username["']?/.test(lower) ||
        /\bplaceholder\s*=\s*["'][^"']*email[^"']*["']/.test(lower))
    ) {
      return 'input[name="email"], input[type="email"], input[autocomplete="username"], input[name="username"], #username, #email, input[placeholder*="email" i]';
    }
    if (
      /^input/i.test(trimmed) &&
      (/\btype\s*=\s*["']?password["']?/.test(lower) ||
        /\bname\s*=\s*["']?password["']?/.test(lower) ||
        /\bplaceholder\s*=\s*["'][^"']*password[^"']*["']/.test(lower))
    ) {
      return 'input[name="password"], input[type="password"], input[autocomplete="current-password"], #password, input[placeholder*="password" i]';
    }
    if (/^(css|xpath|text|id|data-testid)=/i.test(trimmed)) return trimmed;
    if (trimmed.startsWith("//")) return `xpath=${trimmed}`;
    if (/[[\]#>.]/.test(trimmed)) return trimmed;
    return `text=${trimmed}`;
  };
  const parseFillByEquals = (input: string): { field: string; value: string } | null => {
    // Only treat spaced equals as the fill delimiter so CSS attributes like type="email"
    // remain part of the selector.
    const marker = " = ";
    const idx = input.indexOf(marker);
    if (idx < 0) return null;
    const field = input.slice(0, idx).trim();
    const value = input.slice(idx + marker.length).trim();
    if (!field || !value) return null;
    return { field, value };
  };

  if (raw.startsWith("http://") || raw.startsWith("https://") || raw.startsWith("/")) {
    return { kind: "goto", url: raw };
  }

  if (/^precondition:/i.test(raw)) {
    return { kind: "custom", note: raw };
  }

  if (raw.startsWith("//")) {
    return { kind: "custom", note: raw.replace(/^\/\/\s*/, "") };
  }

  const verifyMatch = raw.match(/^verify:\s*(.+)$/i);
  if (verifyMatch) {
    const body = (verifyMatch[1] || "").trim();
    const redirectMatch = body.match(/\bredirect(?:ed)?\b.*\bto\b\s+([^\s,.;]+)/i);
    if (redirectMatch?.[1]) {
      return { kind: "expect-text", text: `url contains ${redirectMatch[1]}` };
    }
    const explicitUrl = body.match(/https?:\/\/[^\s'"`)]+/i)?.[0];
    if (explicitUrl) {
      return { kind: "expect-text", text: explicitUrl };
    }
    // Most Verify lines from sheet/manual inputs are semantic checks, not literal on-page text.
    // Keep them as notes so they don't create brittle getByText assertions.
    return { kind: "custom", note: `Verify: ${body}` };
  }

  const gotoMatch = raw.match(/^(go to|goto|navigate|open)\s+(.+)$/i);
  if (gotoMatch) {
    const target = gotoMatch[2]?.trim();
    if (target) {
      const url = target.startsWith("http") || target.startsWith("/") ? target : `/${target}`;
      return { kind: "goto", url };
    }
  }

  const clickMatch = raw.match(/^(click|tap|press)\s+(.+)$/i);
  if (clickMatch) {
    const target = clickMatch[2]?.trim();
    return { kind: "click", selector: selectorFromTarget(target || "") };
  }

  const fillEqMatch = raw.match(/^(type|fill|enter)\s+(.+)$/i);
  if (fillEqMatch) {
    const parsed = parseFillByEquals(fillEqMatch[2] || "");
    if (parsed) {
      return {
        kind: "fill",
        selector: selectorFromTarget(parsed.field),
        value: parsed.value,
      };
    }
  }

  const fillMatch = raw.match(/^(type|fill|enter)\s+(.+?)(?:\s+(?:with|as|to)\s+|\s*=\s*)(.+)$/i);
  if (fillMatch) {
    const field = fillMatch[2]?.trim();
    const value = fillMatch[3]?.trim();
    return { kind: "fill", selector: selectorFromTarget(field || "input"), value: value || "TODO" };
  }

  const fillSimple = raw.match(/^(type|fill|enter)\s+(.+)$/i);
  if (fillSimple) {
    const field = fillSimple[2]?.trim();
    return { kind: "fill", selector: selectorFromTarget(field || "input"), value: "TODO" };
  }

  const expectMatch = raw.match(/^(expect|assert|verify|see|should)\s+(.+)$/i);
  if (expectMatch) {
    const text = expectMatch[2]?.trim();
    return { kind: "expect-text", text: text || raw };
  }

  return { kind: "expect-text", text: raw };
};

const parseCsv = (input: string): string[][] => {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    const next = input[i + 1];
    if (ch === '"') {
      if (inQuotes && next === '"') {
        cell += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === "," && !inQuotes) {
      row.push(cell.trim());
      cell = "";
      continue;
    }
    if ((ch === "\n" || ch === "\r") && !inQuotes) {
      if (ch === "\r" && next === "\n") i += 1;
      row.push(cell.trim());
      const hasValues = row.some((v) => v.length > 0);
      if (hasValues) rows.push(row);
      row = [];
      cell = "";
      continue;
    }
    cell += ch;
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell.trim());
    const hasValues = row.some((v) => v.length > 0);
    if (hasValues) rows.push(row);
  }
  return rows;
};

const normalizeHeader = (value: string) =>
  value
    .toLowerCase()
    .trim()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");

const pickByHeader = (
  row: Record<string, string>,
  candidates: string[]
) => {
  const normalizedCandidates = candidates.map(normalizeHeader);
  const keys = Object.keys(row);
  for (const key of keys) {
    const normalizedKey = normalizeHeader(key);
    if (normalizedCandidates.includes(normalizedKey)) {
      const value = row[key]?.trim();
      if (value) return value;
    }
  }
  return "";
};

const extractSheetCases = (rows: Record<string, string>[], source: string) => {
  const normalizeLocator = (locatorType: string, locator: string) => {
    const value = locator.trim();
    if (!value) return "";
    const lt = locatorType.toLowerCase();
    if (lt.includes("xpath")) {
      if (value.startsWith("xpath=")) return value;
      if (value.startsWith("//")) return `xpath=${value}`;
    }
    return value;
  };

  const groups = new Map<
    string,
    {
      id: string;
      title: string;
      precondition: string;
      steps: Array<{ idx: number; action: string; locatorType: string; locator: string; testData: string; expected: string }>;
    }
  >();
  let lastCaseId = "";
  let lastTitle = "";
  let lastPrecondition = "";

  rows.forEach((row, idx) => {
    const caseIdRaw = pickByHeader(row, ["test case id", "case id", "id"]);
    const titleRaw = pickByHeader(row, ["test case name", "testcase name", "title", "test case", "scenario", "name"]);
    const preconditionRaw = pickByHeader(row, ["preconditions", "precondition"]);
    const prevCaseId = lastCaseId;
    if (caseIdRaw) {
      const isNewCaseBoundary = caseIdRaw !== prevCaseId;
      lastCaseId = caseIdRaw;
      if (isNewCaseBoundary) {
        lastTitle = titleRaw || caseIdRaw;
        lastPrecondition = preconditionRaw || "";
      } else {
        if (titleRaw) lastTitle = titleRaw;
        if (preconditionRaw) lastPrecondition = preconditionRaw;
      }
    } else {
      if (titleRaw) lastTitle = titleRaw;
      if (preconditionRaw) lastPrecondition = preconditionRaw;
    }

    const caseId = caseIdRaw || lastCaseId;
    const title = titleRaw || lastTitle || `Sheet case ${idx + 1}`;
    const precondition = preconditionRaw || lastPrecondition;
    const stepNoRaw = pickByHeader(row, ["step #", "step no", "step number", "sequence"]);
    const stepNo = Number(stepNoRaw);
    const action = pickByHeader(row, ["action", "step action", "keyword", "steps", "step"]);
    const locatorType = pickByHeader(row, ["locator type", "selector type"]);
    const locator = pickByHeader(row, ["locator", "selector", "css", "xpath"]);
    const testData = pickByHeader(row, ["test data", "data", "value", "input"]);
    const expected = pickByHeader(row, ["expected result", "expected", "result", "assertion"]);

    const key = caseId ? `id:${caseId.toLowerCase()}` : `title:${title.toLowerCase()}`;
    const current = groups.get(key) ?? {
      id: caseId || `${slugify(title)}-${idx + 1}`,
      title,
      precondition,
      steps: [],
    };
    if (!current.precondition && precondition) current.precondition = precondition;
    current.steps.push({
      idx: Number.isFinite(stepNo) && stepNo > 0 ? stepNo : idx + 1,
      action,
      locatorType,
      locator,
      testData,
      expected,
    });
    groups.set(key, current);
  });

  return Array.from(groups.values())
    .map((group) => {
      const steps: string[] = [];
      if (group.precondition) {
        steps.push(`Precondition: ${group.precondition}`);
      }

      group.steps
        .sort((a, b) => a.idx - b.idx)
        .forEach((step) => {
          const locator = normalizeLocator(step.locatorType, step.locator);
          const actionUpper = step.action.toUpperCase();
          if (actionUpper.includes("GOTO") || actionUpper.includes("NAVIGATE") || actionUpper.includes("OPEN")) {
            const target = locator || step.testData;
            if (target) {
              steps.push(target.startsWith("http") || target.startsWith("/") ? target : `go to ${target}`);
            }
          } else if (actionUpper.includes("CLICK")) {
            if (locator) {
              steps.push(`click ${locator}`);
            } else {
              steps.push("click Continue");
            }
          } else if (actionUpper.includes("FILL") || actionUpper.includes("TYPE") || actionUpper.includes("ENTER")) {
            if (locator && step.testData) {
              steps.push(`fill ${locator} = ${step.testData}`);
            } else if (locator) {
              steps.push(`fill ${locator}`);
            }
          } else if (actionUpper.includes("ASSERT_URL_CONTAINS")) {
            if (locator) steps.push(`expect url contains ${locator}`);
            else if (step.expected) steps.push(`expect ${step.expected}`);
          } else if (actionUpper.includes("ASSERT_URL_NOT_CONTAINS")) {
            if (locator) steps.push(`expect url not contains ${locator}`);
            else if (step.expected) steps.push(`expect ${step.expected}`);
          } else if (step.action.trim()) {
            if (locator && step.testData) {
              steps.push(`${step.action} ${locator} ${step.testData}`.trim());
            } else if (locator) {
              steps.push(`${step.action} ${locator}`.trim());
            } else {
              steps.push(step.action.trim());
            }
          }

          if (step.expected) {
            steps.push(`Verify: ${step.expected}`);
          }
        });

      if (!steps.length) {
        return null;
      }
      return {
        id: group.id,
        title: group.title,
        steps,
        source,
      };
    })
    .filter((item): item is { id: string; title: string; steps: string[]; source: string } => !!item);
};

const toGoogleSheetCsvUrl = (rawUrl: string) => {
  const url = new URL(rawUrl);
  if (!/docs\.google\.com$/i.test(url.hostname) || !url.pathname.includes("/spreadsheets/")) {
    throw new Error("Provide a valid Google Sheets URL");
  }

  const idMatch = url.pathname.match(/\/d\/([a-zA-Z0-9-_]+)/);
  if (!idMatch?.[1]) throw new Error("Could not parse Google Sheet ID");

  const gidFromHash = url.hash.match(/gid=([0-9]+)/)?.[1];
  const gid = gidFromHash || url.searchParams.get("gid") || "";
  const csvUrl = new URL(`https://docs.google.com/spreadsheets/d/${idMatch[1]}/export`);
  csvUrl.searchParams.set("format", "csv");
  if (gid) csvUrl.searchParams.set("gid", gid);
  return csvUrl.toString();
};

export default async function testBuilderRoutes(app: FastifyInstance): Promise<void> {
  app.post("/test-builder/google-sheet-preview", async (req, reply) => {
    const { userId } = getAuth(req);
    if (!userId) return reply.code(401).send({ error: "Unauthorized" });

    const parsed = googleSheetPreviewSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    try {
      const csvUrl = toGoogleSheetCsvUrl(parsed.data.url);
      const response = await fetch(csvUrl);
      if (!response.ok) {
        return reply.code(400).send({ error: "Unable to read Google Sheet. Make sure it is accessible." });
      }
      const csv = await response.text();
      const matrix = parseCsv(csv);
      if (!matrix.length) return reply.send({ cases: [] });
      const headers = matrix[0] || [];
      const bodyRows = matrix.slice(1);
      const rows = bodyRows.map((cells) => {
        const record: Record<string, string> = {};
        headers.forEach((header, idx) => {
          if (!header?.trim()) return;
          record[header] = (cells[idx] || "").trim();
        });
        return record;
      });
      const cases = extractSheetCases(rows, "Google Sheet");
      return reply.send({ cases });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load Google Sheet";
      return reply.code(400).send({ error: message });
    }
  });

  app.post("/test-builder/generate", async (req, reply) => {
    const { userId } = getAuth(req);
    if (!userId) return reply.code(401).send({ error: "Unauthorized" });

    const parsed = generateSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    const { projectId, title, steps, notes, docs, baseUrl } = parsed.data;
    const project = await prisma.project.findFirst({
      where: { id: projectId, ownerId: userId },
      select: { id: true, sharedSteps: true },
    });
    if (!project) return reply.code(404).send({ error: "Project not found" });

    const slug = slugify(title);
    const pagePath = `/manual/${slug}`;
    const sharedStepsObj = (project.sharedSteps ?? {}) as Record<string, any>;
    const preconditions = steps
      .map((s) => s.trim())
      .filter((s) => /^precondition:/i.test(s))
      .map((s) => s.replace(/^precondition:\s*/i, "").trim())
      .filter(Boolean);
    const requestedShared = parseSharedStepRequests(preconditions);
    const expandedSharedLines = expandNamedSharedSteps(sharedStepsObj, requestedShared.named);
    const parsedSteps = [...expandedSharedLines, ...steps].map(parseStepLine);
    const plan: TestPlan = {
      baseUrl:
        baseUrl?.trim() ||
        ((project.sharedSteps as any)?.baseUrl as string | undefined) ||
        "http://localhost:5173",
      cases: [
        {
          id: `manual-${Date.now()}`,
          name: title,
          group: { page: pagePath },
          steps: parsedSteps,
        },
      ],
      meta: { notes, docs },
    };

    const adapterId = "playwright-ts";
    const outDir = path.join(GENERATED_ROOT, `${adapterId}-${userId}`, projectId);
    await fs.mkdir(outDir, { recursive: true });
    if (adapterId === "playwright-ts") {
      const fileName = filenameFromPagePath(pagePath);
      const baseUrlResolved =
        baseUrl?.trim() ||
        ((project.sharedSteps as any)?.baseUrl as string | undefined) ||
        "http://localhost:5173";
      const content = renderSimplePlaywrightSpec(title, parsedSteps, baseUrlResolved, {
        sharedSteps: sharedStepsObj,
        preconditions,
      });
      await fs.writeFile(path.join(outDir, fileName), content, "utf8");
    } else {
      await writeSpecsFromPlan(outDir, plan, adapterId);
    }

    const fileName = filenameFromPagePath(pagePath);
    const relativePath = path.posix.join(
      "testmind-generated",
      `${adapterId}-${userId}`,
      projectId,
      fileName
    );

    return reply.send({
      spec: {
        title,
        fileName,
        relativePath,
      },
    });
  });

  app.post("/test-builder/curate", async (req, reply) => {
    const { userId } = getAuth(req);
    if (!userId) return reply.code(401).send({ error: "Unauthorized" });

    const parsed = curateSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    const { projectId, specPath, curatedName } = parsed.data;
    const project = await prisma.project.findFirst({
      where: { id: projectId, ownerId: userId },
      select: { id: true, name: true },
    });
    if (!project) return reply.code(404).send({ error: "Project not found" });

    const relPath = normalizeGeneratedRelPath(specPath);
    const sourceAbs = path.resolve(GENERATED_ROOT, relPath);
    ensureWithin(GENERATED_ROOT, sourceAbs);
    if (!fsSync.existsSync(sourceAbs)) {
      return reply.code(404).send({ error: "Generated spec not found" });
    }

    const existingSuite = await prisma.curatedSuite.findFirst({
      where: { projectId, project: { ownerId: userId } },
      select: { id: true, name: true, rootRel: true, projectId: true },
      orderBy: { updatedAt: "desc" },
    });

    let suite = existingSuite;
    if (!suite) {
      const suiteName = `${project.name ?? "Project"} Suite`;
      const slug = slugify(suiteName);
      const rootRel = `project-${projectId}/${slug}`;
      suite = await prisma.curatedSuite.create({
        data: { projectId, name: suiteName, rootRel },
        select: { id: true, name: true, rootRel: true, projectId: true },
      });

      const manifest = readCuratedManifest();
      const existing = manifest.projects.find((p) => p.id === suite.id);
      if (existing) {
        existing.name = suite.name;
        existing.root = suite.rootRel;
      } else {
        manifest.projects.push({ id: suite.id, name: suite.name, root: suite.rootRel, locked: [] });
      }
      writeCuratedManifest(manifest);
    }
    if (!suite) {
      return reply.code(500).send({ error: "Failed to resolve curated suite" });
    }

    const destFileBase = curatedName?.trim()
      ? `${slugify(curatedName)}.spec.ts`
      : path.posix.basename(relPath);
    const destRoot = path.resolve(CURATED_ROOT, suite.rootRel);
    const destAbs = path.resolve(destRoot, destFileBase);
    ensureWithin(destRoot, destAbs);

    await fs.mkdir(path.dirname(destAbs), { recursive: true });
    await fs.copyFile(sourceAbs, destAbs);

    const curatedRootRel = suite.rootRel.replace(/\\/g, "/");
    const curatedPath = path.posix.join("testmind-curated", curatedRootRel, destFileBase);
    return reply.send({ fileName: destFileBase, curatedPath });
  });
}
