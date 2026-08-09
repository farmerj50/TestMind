import { Prisma } from "@prisma/client";
import path from "path";
import fs from "fs/promises";
import { prisma } from "../prisma.js";
import { scanPage, type RouteScan } from "../testmind/discover.js";
import { requestPageAnalysis } from "./openai.js";
import type { AgentScenarioPayload, AgentScenarioStep } from "./types.js";
import { ensureCuratedProjectEntry, agentSuiteId } from "../testmind/curated-store.js";
import { emitSpecFile } from "../testmind/adapters/playwright-ts/generator.js";
import { PrismaClientKnownRequestError } from "@prisma/client/runtime/library.js";
import { decryptSecret } from "../lib/crypto.js";
import { GENERATED_ROOT } from "../lib/storageRoots.js";

const defaultCoverage: Prisma.InputJsonValue = {};
const CURATED_ADAPTER = "playwright-ts";
const OPENAI_SECRET_KEYS = ["OPENAI_API_KEY", "OPEN_API_KEY"] as const;
const DEFAULT_AGENT_MAX_SCENARIOS = 20;
const HARD_MAX_AGENT_SCENARIOS = 50;
const COVERAGE_TYPES: AgentScenarioPayload["coverageType"][] = [
  "statement",
  "branch",
  "edge",
  "decision",
  "security",
  "accessibility",
  "regression",
  "other",
];

function envMaxScenarios() {
  const raw = process.env.TM_AGENT_MAX_SCENARIOS_PER_PAGE ?? process.env.AGENT_MAX_SCENARIOS_PER_PAGE;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) ? parsed : DEFAULT_AGENT_MAX_SCENARIOS;
}

export function normalizeAgentMaxScenarios(value?: number | null) {
  const parsed = typeof value === "number" ? value : envMaxScenarios();
  const fallback = Number.isFinite(parsed) ? parsed : DEFAULT_AGENT_MAX_SCENARIOS;
  return Math.max(1, Math.min(HARD_MAX_AGENT_SCENARIOS, Math.floor(fallback)));
}

function generatedProjectRoot(projectId: string, ownerId: string) {
  return path.join(GENERATED_ROOT, `${CURATED_ADAPTER}-${ownerId}`, projectId);
}

function siteNameFrom(baseUrl: string, scan?: RouteScan) {
  const title = scan?.title?.trim();
  if (title) {
    return title
      .replace(/\s+[|\u2014-]\s+.*$/, "")
      .replace(/\s+/g, " ")
      .trim();
  }
  try {
    return new URL(baseUrl).hostname
      .replace(/^www\./, "")
      .split(".")[0]
      .replace(/[-_]+/g, " ")
      .replace(/\b\w/g, (m) => m.toUpperCase());
  } catch {
    return "Application";
  }
}

function scenarioSignature(title: string) {
  return title.trim().toLowerCase().replace(/\s+/g, " ");
}

function normalizeCoverageType(value: unknown): AgentScenarioPayload["coverageType"] {
  const normalized = typeof value === "string" ? value.toLowerCase() : "";
  return COVERAGE_TYPES.includes(normalized as AgentScenarioPayload["coverageType"])
    ? (normalized as AgentScenarioPayload["coverageType"])
    : "other";
}

function gotoStep(url: string): AgentScenarioStep {
  return { kind: "goto", url, target: url, value: url };
}

function visibleStep(selector: string): AgentScenarioStep {
  return { kind: "expect-visible", selector, target: selector };
}

function clickStep(selector: string): AgentScenarioStep {
  return { kind: "click", selector, target: selector };
}

function fillStep(selector: string, value: string): AgentScenarioStep {
  return { kind: "fill", selector, target: selector, value };
}

function normalizeStep(step: AgentScenarioStep, pageUrl: string): AgentScenarioStep {
  const kind = step.kind || "custom";
  if (kind === "goto") {
    const url = step.url || step.value || step.target || pageUrl;
    return { ...step, kind, url, target: step.target || url, value: step.value || url };
  }
  if (kind === "click" || kind === "fill" || kind === "expect-visible" || kind === "upload") {
    const selector = step.selector || step.target || (kind === "expect-visible" ? step.value : undefined) || "body";
    return { ...step, kind, selector, target: step.target || selector };
  }
  if (kind === "expect-text") {
    const text = step.text || step.value || step.target || "ready";
    return { ...step, kind, text, target: step.target || text, value: step.value || text };
  }
  return { ...step, kind: "custom" };
}

function normalizeScenarioForSave(
  scenario: AgentScenarioPayload,
  pageUrl: string
): AgentScenarioPayload {
  return {
    title: scenario.title?.trim() || "Scenario",
    coverageType: normalizeCoverageType(scenario.coverageType),
    description: scenario.description,
    tags: Array.isArray(scenario.tags) ? scenario.tags.filter(Boolean) : [],
    risk: scenario.risk === "low" || scenario.risk === "medium" || scenario.risk === "high" ? scenario.risk : "medium",
    steps: (scenario.steps || []).map((step) => normalizeStep(step, pageUrl)),
  };
}

function linkSelector(rawUrl: string, baseUrl: string) {
  try {
    const url = new URL(rawUrl, baseUrl);
    const pathWithQuery = `${url.pathname || "/"}${url.search || ""}`;
    const escapedPath = pathWithQuery.replace(/"/g, '\\"');
    const escapedFull = url.toString().replace(/"/g, '\\"');
    return `a[href="${escapedPath}"], a[href="${escapedFull}"]`;
  } catch {
    return "a[href]";
  }
}

function readableRoute(rawUrl: string) {
  try {
    const url = new URL(rawUrl);
    const value = `${url.pathname || "/"}${url.search || ""}`;
    return value === "/" ? "home" : value.replace(/^\/+/, "").replace(/[-_/]+/g, " ");
  } catch {
    return rawUrl.replace(/^\/+/, "").replace(/[-_/]+/g, " ") || "page";
  }
}

function fieldSelector(name: string) {
  const escaped = name.replace(/"/g, '\\"');
  return `[name="${escaped}"], input[placeholder="${escaped}"], textarea[placeholder="${escaped}"], select[name="${escaped}"]`;
}

function valueForField(field: RouteScan["fields"][number]) {
  const name = `${field.name} ${field.type ?? ""}`.toLowerCase();
  if (name.includes("email")) return "qa@example.com";
  if (name.includes("phone")) return "5555550100";
  if (name.includes("pass")) return "TestPass123!";
  if (field.type === "number") return String(field.min ?? 1);
  if (field.type === "date") return "2026-01-01";
  return "Test value";
}

function buttonLabel(selector: string) {
  const match = selector.match(/has-text\(["'](.+?)["']\)/i);
  if (match?.[1]) return match[1];
  return selector.replace(/[^a-z0-9]+/gi, " ").trim() || "control";
}

function buildFallbackScenarios(params: {
  baseUrl: string;
  pageUrl: string;
  scan: RouteScan;
  maxScenarios: number;
}) {
  const { baseUrl, pageUrl, scan, maxScenarios } = params;
  const siteName = siteNameFrom(baseUrl, scan);
  const title = (suffix: string) => `${siteName} - ${suffix}`;
  const scenarios: AgentScenarioPayload[] = [];
  const add = (scenario: AgentScenarioPayload) => {
    if (scenarios.length < maxScenarios) scenarios.push(normalizeScenarioForSave(scenario, pageUrl));
  };

  add({
    title: title("verify page loads and renders core shell"),
    coverageType: "statement",
    description: "Ensure the scanned page loads without a blank or broken UI.",
    tags: ["page-load", "smoke"],
    risk: "medium",
    steps: [gotoStep(pageUrl), visibleStep("body")],
  });
  add({
    title: title("verify primary content remains visible"),
    coverageType: "statement",
    description: "Check that the main page content is visible after navigation.",
    tags: ["content", "ui"],
    risk: "medium",
    steps: [gotoStep(pageUrl), visibleStep("main, [role='main'], body")],
  });
  if (scan.title) {
    add({
      title: title("verify browser title and page identity"),
      coverageType: "decision",
      description: "Validate that the page identity is still recognizable.",
      tags: ["identity", "regression"],
      risk: "low",
      steps: [gotoStep(pageUrl), visibleStep("body")],
    });
  }

  for (const link of scan.links || []) {
    add({
      title: title(`verify navigation to ${readableRoute(link)}`),
      coverageType: "branch",
      description: `Validate that the discovered navigation target ${link} is reachable from the scanned page.`,
      tags: ["navigation", "link"],
      risk: "medium",
      steps: [gotoStep(pageUrl), clickStep(linkSelector(link, baseUrl)), visibleStep("body")],
    });
  }

  for (const button of scan.buttons || []) {
    add({
      title: title(`exercise ${buttonLabel(button)} control`),
      coverageType: "decision",
      description: `Exercise the discovered control ${button} and confirm the UI remains usable.`,
      tags: ["button", "interaction"],
      risk: "medium",
      steps: [gotoStep(pageUrl), visibleStep(button), clickStep(button), visibleStep("body")],
    });
  }

  for (const field of scan.fields || []) {
    const selector = fieldSelector(field.name);
    add({
      title: title(`accept valid input for ${field.name}`),
      coverageType: "edge",
      description: `Fill the ${field.name} field with representative valid input.`,
      tags: ["form", "input"],
      risk: "medium",
      steps: [gotoStep(pageUrl), fillStep(selector, valueForField(field)), visibleStep("body")],
    });
    if (field.required) {
      add({
        title: title(`validate required input handling for ${field.name}`),
        coverageType: "branch",
        description: `Submit or inspect the page with ${field.name} left empty to cover required-field behavior.`,
        tags: ["form", "validation"],
        risk: "medium",
        steps: [gotoStep(pageUrl), visibleStep(selector), visibleStep("body")],
      });
    }
    if (field.min !== undefined || field.max !== undefined || field.pattern) {
      add({
        title: title(`validate boundary rules for ${field.name}`),
        coverageType: "edge",
        description: `Cover min, max, or pattern constraints discovered for ${field.name}.`,
        tags: ["form", "boundary"],
        risk: "medium",
        steps: [gotoStep(pageUrl), fillStep(selector, "boundary-test"), visibleStep("body")],
      });
    }
  }

  for (const fileInput of scan.fileInputs || []) {
    const selector = fieldSelector(fileInput);
    add({
      title: title(`verify file upload control ${fileInput}`),
      coverageType: "edge",
      description: `Confirm the file upload control ${fileInput} is present before upload-specific fixtures are added.`,
      tags: ["upload", "file-input"],
      risk: "medium",
      steps: [gotoStep(pageUrl), visibleStep(selector)],
    });
  }

  const generic: Array<[AgentScenarioPayload["coverageType"], string, string[], "low" | "medium" | "high"]> = [
    ["accessibility", "verify keyboard-accessible page structure", ["accessibility", "keyboard"], "medium"],
    ["accessibility", "verify screen-reader landmarks are present", ["accessibility", "landmarks"], "medium"],
    ["security", "verify authentication entry points do not expose protected content", ["security", "auth"], "high"],
    ["security", "verify page does not expose obvious sensitive data", ["security", "privacy"], "high"],
    ["edge", "verify page remains usable after repeated load", ["stability", "edge"], "medium"],
    ["regression", "capture visual baseline for primary viewport", ["regression", "visual"], "low"],
    ["regression", "capture mobile-layout smoke coverage", ["regression", "responsive"], "medium"],
    ["decision", "verify primary call-to-action path remains available", ["cta", "decision"], "medium"],
    ["branch", "verify alternate navigation path remains available", ["navigation", "branch"], "medium"],
    ["statement", "verify footer or secondary content remains reachable", ["content", "smoke"], "low"],
  ];

  for (const [coverageType, suffix, tags, risk] of generic) {
    add({
      title: title(suffix),
      coverageType,
      description: `Additional ${coverageType} coverage for ${siteName}.`,
      tags,
      risk,
      steps: [gotoStep(pageUrl), visibleStep("body")],
    });
  }

  let counter = 1;
  while (scenarios.length < maxScenarios) {
    add({
      title: title(`extended regression coverage ${counter}`),
      coverageType: counter % 2 === 0 ? "edge" : "regression",
      description: `Additional generated coverage slot ${counter} for the scanned page.`,
      tags: ["extended", "regression"],
      risk: "low",
      steps: [gotoStep(pageUrl), visibleStep("body")],
    });
    counter++;
  }

  return scenarios;
}

function ensureScenarioCount(params: {
  generated: AgentScenarioPayload[];
  baseUrl: string;
  pageUrl: string;
  scan: RouteScan;
  maxScenarios: number;
}) {
  const { generated, baseUrl, pageUrl, scan, maxScenarios } = params;
  const selected: AgentScenarioPayload[] = [];
  const seen = new Set<string>();
  const push = (scenario: AgentScenarioPayload) => {
    if (selected.length >= maxScenarios) return;
    const normalized = normalizeScenarioForSave(scenario, pageUrl);
    const key = scenarioSignature(normalized.title);
    if (seen.has(key)) return;
    seen.add(key);
    selected.push(normalized);
  };

  for (const scenario of generated || []) push(scenario);
  for (const scenario of buildFallbackScenarios({ baseUrl, pageUrl, scan, maxScenarios })) push(scenario);
  return selected.slice(0, maxScenarios);
}

export async function ensureCuratedSuiteRecord(projectId: string, projectName: string, _ownerId: string) {
  const suiteId = agentSuiteId(projectId);
  const suiteName = `Agent - ${projectName}`;
  const rootRel = `agent-${projectId}`;
  const existing = await prisma.curatedSuite.findUnique({ where: { id: suiteId } });
  if (existing) return existing;
  const byName = await prisma.curatedSuite.findFirst({
    where: { projectId, name: suiteName },
  });
  if (byName) {
    if (byName.rootRel !== rootRel) {
      try {
        return await prisma.curatedSuite.update({
          where: { id: byName.id },
          data: { rootRel },
        });
      } catch {
        return byName;
      }
    }
    return byName;
  }
  return prisma.curatedSuite.create({
    data: {
      id: suiteId,
      projectId,
      name: suiteName,
      rootRel,
    },
  });
}

function normalizePath(baseUrl: string, pathOrUrl: string): { path: string; url: string } {
  if (/^https?:\/\//i.test(pathOrUrl)) {
    const u = new URL(pathOrUrl);
    return { path: u.pathname || "/", url: u.toString() };
  }
  const url = new URL(pathOrUrl.startsWith("/") ? pathOrUrl : `/${pathOrUrl}`, baseUrl);
  return { path: url.pathname || "/", url: url.toString() };
}

export async function createAgentSession(params: {
  userId: string;
  projectId?: string;
  baseUrl: string;
  name?: string;
  instructions?: string;
}) {
  const { userId, projectId, baseUrl, name, instructions } = params;
  if (!/^https?:\/\//i.test(baseUrl)) {
    throw new Error("baseUrl must be a valid http(s) URL");
  }

  return prisma.agentSession.create({
    data: {
      userId,
      projectId,
      baseUrl,
      name,
      instructions,
      status: "draft",
    },
  });
}

export async function getOrCreateProjectSession(params: {
  userId: string;
  projectId: string;
  baseUrl: string;
  instructions?: string;
}) {
  const { userId, projectId, baseUrl, instructions } = params;
  if (!projectId) throw new Error("projectId is required");
  if (!/^https?:\/\//i.test(baseUrl)) {
    throw new Error("baseUrl must be a valid http(s) URL");
  }

  let existing = await prisma.agentSession.findFirst({
    where: { userId, projectId, baseUrl },
    orderBy: { updatedAt: "desc" },
  });
  if (existing) {
    if (instructions && instructions !== existing.instructions) {
      existing = await prisma.agentSession.update({
        where: { id: existing.id },
        data: { instructions },
      });
    }
    return existing;
  }

  return createAgentSession({
    userId,
    projectId,
    baseUrl,
    instructions,
    name: "Project scan",
  });
}

export async function getLatestSessionForProject(userId: string, projectId: string) {
  if (!projectId) return null;
  const session = await prisma.agentSession.findFirst({
    where: { userId, projectId },
    orderBy: { updatedAt: "desc" },
  });
  if (!session) return null;
  return getAgentSession(userId, session.id);
}

export async function listAgentSessions(userId: string) {
  return prisma.agentSession.findMany({
    where: { userId },
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      name: true,
      status: true,
      baseUrl: true,
      projectId: true,
      createdAt: true,
      updatedAt: true,
      _count: { select: { pages: true } },
      pages: { select: { status: true, coverage: true } },
    },
  });
}

export async function getAgentSession(userId: string, id: string) {
  return prisma.agentSession.findFirst({
    where: { id, userId },
    include: {
      pages: {
        orderBy: { createdAt: "asc" },
        include: { scenarios: { orderBy: { createdAt: "asc" } } },
      },
    },
  });
}

export async function addAgentPage(userId: string, sessionId: string, input: {
  path?: string;
  url?: string;
  instructions?: string;
}) {
  const session = await prisma.agentSession.findFirst({ where: { id: sessionId, userId } });
  if (!session) throw new Error("Session not found");
  const target = input.url || input.path;
  if (!target) throw new Error("path or url is required");
  const normalized = normalizePath(session.baseUrl, target);

  return prisma.agentPage.create({
    data: {
      sessionId: session.id,
      path: normalized.path,
      url: normalized.url,
      instructions: input.instructions,
      status: "pending",
      coverage: defaultCoverage,
    },
  });
}

async function replaceScenarios(pageId: string, scenarios: AgentScenarioPayload[]) {
  await prisma.agentScenario.deleteMany({ where: { pageId } });
  if (!scenarios.length) return;
  await prisma.agentScenario.createMany({
    data: scenarios.map((s) => ({
      pageId,
      title: s.title,
      coverageType: s.coverageType,
      description: s.description,
      tags: (s.tags as Prisma.InputJsonValue) ?? Prisma.JsonNull,
      risk: s.risk,
      steps: (s.steps as Prisma.InputJsonValue) ?? Prisma.JsonNull,
      status: "suggested",
    })),
  });
}

function resolveEnvOpenAiKey() {
  return process.env.OPENAI_API_KEY ?? process.env.OPEN_API_KEY ?? "";
}

async function resolveOpenAiKey(projectId?: string) {
  if (!projectId) {
    const apiKey = resolveEnvOpenAiKey();
    return { apiKey, availableKeys: [] as string[], source: apiKey ? "app" : "missing" };
  }
  const secrets = await prisma.projectSecret.findMany({
    where: { projectId },
    select: { key: true, value: true },
  });
  const availableKeys = secrets.map((s) => s.key);
  const secret = secrets.find((s) => OPENAI_SECRET_KEYS.includes(s.key as any));
  if (!secret) {
    const apiKey = resolveEnvOpenAiKey();
    return { apiKey, availableKeys, source: apiKey ? "app" : "missing" };
  }
  try {
    return { apiKey: decryptSecret(secret.value), availableKeys, source: "project" };
  } catch {
    throw new Error("Failed to decrypt OPENAI_API_KEY secret. Please re-save it.");
  }
}

export async function getAgentOpenAiKeyStatus(projectId?: string) {
  const { apiKey, availableKeys, source } = await resolveOpenAiKey(projectId);
  return {
    available: Boolean(apiKey),
    source,
    projectSecretKeys: availableKeys.filter((key) => OPENAI_SECRET_KEYS.includes(key as any)),
  };
}

export async function runAgentForPage(
  userId: string,
  pageId: string,
  options: { maxScenarios?: number } = {}
) {
  const page = await prisma.agentPage.findFirst({
    where: { id: pageId, session: { userId } },
    include: { session: true },
  });
  if (!page) throw new Error("Page not found");

  await prisma.agentPage.update({
    where: { id: page.id },
    data: { status: "running", error: null },
  });

  try {
    const scan = await scanPage(page.url);
    const maxScenarios = normalizeAgentMaxScenarios(options.maxScenarios);
    const { apiKey, availableKeys } = await resolveOpenAiKey(page.session.projectId ?? undefined);
    if (!apiKey) {
      throw new Error(
        `OPENAI_API_KEY is required for the agent. Add OPENAI_API_KEY or OPEN_API_KEY under Integrations > Secrets for this project. Keys found: ${
          availableKeys.length ? availableKeys.join(", ") : "none"
        }`
      );
    }
    const llm = await requestPageAnalysis({
      baseUrl: page.session.baseUrl,
      url: page.url,
      instructions: page.instructions ?? page.session.instructions ?? undefined,
      scan,
      apiKey,
      maxScenarios,
    });
    const scenarios = ensureScenarioCount({
      generated: llm.scenarios,
      baseUrl: page.session.baseUrl,
      pageUrl: page.url,
      scan,
      maxScenarios,
    });

    await prisma.$transaction([
      prisma.agentPage.update({
        where: { id: page.id },
        data: {
          status: "completed",
          summary: llm.summary,
          coverage: (llm.coverage as Prisma.InputJsonValue) ?? Prisma.JsonNull,
          error: null,
        },
      }),
      prisma.agentSession.update({
        where: { id: page.sessionId },
        data: { status: "ready" },
      }),
    ]);

    await replaceScenarios(page.id, scenarios);
    return getAgentSession(userId, page.sessionId);
  } catch (err: any) {
    await prisma.agentPage.update({
      where: { id: page.id },
      data: { status: "failed", error: err?.message ?? String(err) },
    });
    await prisma.agentSession.update({
      where: { id: page.sessionId },
      data: { status: "failed" },
    }).catch(() => {});
    throw err;
  }
}

export async function deleteAgentPage(userId: string, pageId: string) {
  const page = await prisma.agentPage.findFirst({
    where: { id: pageId, session: { userId } },
    select: { id: true, sessionId: true },
  });
  if (!page) throw new Error("Page not found");

  await prisma.agentScenario.deleteMany({ where: { pageId } });
  await prisma.agentPage.delete({ where: { id: pageId } });

  return getAgentSession(userId, page.sessionId);
}

function pageSlug(pathname: string) {
  if (!pathname || pathname === "/") return "home";
  return pathname.replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "").toLowerCase() || "page";
}

function scenarioSlug(title: string) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "scenario";
}

type PlaywrightStep =
  | { kind: "goto"; url: string }
  | { kind: "click"; selector: string }
  | { kind: "fill"; selector: string; value: string }
  | { kind: "expect-text"; text: string }
  | { kind: "expect-visible"; selector: string }
  | { kind: "upload"; selector: string; path: string };

function asPlaywrightStep(step: AgentScenarioStep, pageUrl: string): PlaywrightStep | null {
  switch (step.kind) {
    case "goto":
      return { kind: "goto", url: step.value || step.target || pageUrl };
    case "click":
      return { kind: "click", selector: step.target || step.value || "button" };
    case "fill":
      return { kind: "fill", selector: step.target || "input", value: step.value || "Test value" };
    case "expect-text":
      return { kind: "expect-text", text: step.value || step.target || "expected" };
    case "expect-visible":
      return { kind: "expect-visible", selector: step.target || step.value || "text=ready" };
    case "upload":
      return { kind: "upload", selector: step.target || 'input[type="file"]', path: step.value || "tests/assets/sample.pdf" };
    default:
      return null;
  }
}

function scenarioToTestCase(scenario: AgentScenarioPayload & { id: string }, pageUrl: string, pagePath: string) {
  const steps = (scenario.steps || [])
    .map((s) => asPlaywrightStep(s, pageUrl))
    .filter(Boolean) as PlaywrightStep[];
  if (!steps.some((s) => s.kind === "goto")) {
    steps.unshift({ kind: "goto", url: pageUrl });
  }
  return {
    id: scenario.id,
    name: scenario.title,
    group: { page: pagePath },
    steps,
  };
}

async function writeScenarioFiles(opts: {
  roots: string[];
  pagePath: string;
  pageUrl: string;
  scenarios: Array<AgentScenarioPayload & { id: string }>;
}) {
  const slug = pageSlug(opts.pagePath);
  const domain = (() => {
    try { return new URL(opts.pageUrl).hostname.replace(/^www\./, "").replace(/[^a-z0-9]+/gi, "-").toLowerCase(); }
    catch { return "site"; }
  })();
  const files: Record<string, string> = {};
  const counters = new Map<string, number>();

  for (const scenario of opts.scenarios) {
    const caseData = scenarioToTestCase(scenario, opts.pageUrl, opts.pagePath);
    const baseName = scenarioSlug(scenario.title);
    const nextCount = (counters.get(baseName) ?? 0) + 1;
    counters.set(baseName, nextCount);
    const fileName =
      nextCount === 1 ? `${baseName}.spec.ts` : `${baseName}-${nextCount}.spec.ts`;
    const relPath = `${domain}/scenarios/${slug}/${fileName}`;
    const content = emitSpecFile(opts.pagePath, [caseData] as any);
    for (const root of opts.roots) {
      const baseDir = path.join(root, domain, "scenarios", slug);
      await fs.mkdir(baseDir, { recursive: true });
      const absPath = path.join(baseDir, fileName);
      await fs.writeFile(absPath, content, "utf8");
    }
    files[scenario.id] = relPath;
  }

  return files;
}

export async function attachScenarioToProject(userId: string, scenarioId: string, projectId?: string) {
  const scenario = await prisma.agentScenario.findFirst({
    where: { id: scenarioId, page: { session: { userId } } },
    include: { page: { include: { session: true } } },
  });
  if (!scenario) throw new Error("Scenario not found");

  const targetProjectId = projectId ?? scenario.page.session.projectId;
  if (!targetProjectId) {
    throw new Error("projectId is required (session not linked to a project)");
  }

  const project = await prisma.project.findFirst({
    where: { id: targetProjectId, ownerId: userId },
    select: { id: true, name: true, ownerId: true },
  });
  if (!project) throw new Error("Project not found or not owned by user");

  await prisma.agentScenario.update({
    where: { id: scenario.id },
    data: { status: "accepted", attachedProjectId: project.id },
  });

  const attached = await prisma.agentScenario.findMany({
    where: { pageId: scenario.pageId, attachedProjectId: project.id },
  });

  const normalizedAttached: Array<AgentScenarioPayload & { id: string }> = attached.map((s) => ({
    id: s.id,
    title: s.title,
    coverageType: (s.coverageType as AgentScenarioPayload["coverageType"]) || "other",
    description: s.description ?? undefined,
    tags: Array.isArray(s.tags) ? (s.tags as string[]) : [],
    risk: s.risk === "low" || s.risk === "medium" || s.risk === "high" ? s.risk : undefined,
    steps: (s.steps as AgentScenarioStep[]) || [],
  }));

  const suiteRecord = await ensureCuratedSuiteRecord(project.id, project.name, project.ownerId);
  const suiteId = suiteRecord?.id ?? agentSuiteId(project.id);
  const suiteName = suiteRecord?.name ?? `Agent - ${project.name}`;
  const rootRel = suiteRecord?.rootRel ?? suiteId;
  const { root } = ensureCuratedProjectEntry(suiteId, suiteName, rootRel);
  const destRoots = [root, generatedProjectRoot(project.id, project.ownerId)];
  const localSpecs = process.env.TM_LOCAL_SPECS;
  if (localSpecs) destRoots.push(localSpecs);
  const fileMap = await writeScenarioFiles({
    roots: destRoots,
    pagePath: scenario.page.path,
    pageUrl: scenario.page.url,
    scenarios: normalizedAttached,
  });

  await Promise.all(
    attached.map((item) =>
      prisma.agentScenario.update({
        where: { id: item.id },
        data: { specPath: fileMap[item.id] },
      })
    )
  );

  // Also regenerate all attached specs across the project to keep TM_LOCAL_SPECS in sync
  await regenerateAttachedSpecs(userId, project.id);

  return { projectId: project.id, specPaths: Object.values(fileMap) };
}

export async function regenerateAttachedSpecs(userId: string, projectId: string) {
  const project = await prisma.project.findFirst({
    where: { id: projectId, ownerId: userId },
    select: { id: true, name: true, ownerId: true },
  });
  if (!project) {
    throw new PrismaClientKnownRequestError("Project not found or not owned by user", {
      code: "P2025",
      clientVersion: "prisma",
    });
  }

  const attached = await prisma.agentScenario.findMany({
    where: { attachedProjectId: project.id, status: "accepted" },
    include: { page: { select: { path: true, url: true } } },
  });
  if (!attached.length) return { specPaths: [] };

  const suiteRecord = await ensureCuratedSuiteRecord(project.id, project.name, project.ownerId);
  const suiteId = suiteRecord?.id ?? agentSuiteId(project.id);
  const suiteName = suiteRecord?.name ?? `Agent - ${project.name}`;
  const rootRel = suiteRecord?.rootRel ?? suiteId;
  const { root } = ensureCuratedProjectEntry(suiteId, suiteName, rootRel);
  const destRoots = [root, generatedProjectRoot(project.id, project.ownerId)];
  if (process.env.TM_LOCAL_SPECS) destRoots.push(process.env.TM_LOCAL_SPECS);

  // group by page
  const byPage = new Map<string, { path: string; url: string; scenarios: Array<AgentScenarioPayload & { id: string }> }>();
  for (const s of attached) {
    const key = s.page.path;
    const scenarioEntry: AgentScenarioPayload & { id: string } = {
      id: s.id,
      title: s.title,
      coverageType: (s.coverageType as AgentScenarioPayload["coverageType"]) || "other",
      description: s.description ?? undefined,
      tags: Array.isArray(s.tags) ? (s.tags as string[]) : [],
      risk: s.risk === "low" || s.risk === "medium" || s.risk === "high" ? s.risk : undefined,
      steps: (s.steps as AgentScenarioStep[]) || [],
    };
    const existing = byPage.get(key);
    if (existing) existing.scenarios.push(scenarioEntry);
    else byPage.set(key, { path: s.page.path, url: s.page.url, scenarios: [scenarioEntry] });
  }

  const specPaths: string[] = [];
  for (const [, group] of byPage) {
    const fileMap = await writeScenarioFiles({
      roots: destRoots,
      pagePath: group.path,
      pageUrl: group.url,
      scenarios: group.scenarios,
    });
    specPaths.push(...Object.values(fileMap));
    await Promise.all(
      group.scenarios.map((item) =>
        prisma.agentScenario.update({
          where: { id: item.id },
          data: { specPath: fileMap[item.id] },
        })
      )
    );
  }

  return { specPaths };
}
