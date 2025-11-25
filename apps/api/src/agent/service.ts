import { Prisma } from "@prisma/client";
import path from "path";
import fs from "fs/promises";
import { prisma } from "../prisma.js";
import { scanPage } from "../testmind/discover.js";
import { requestPageAnalysis } from "./openai.js";
import type { AgentScenarioPayload, AgentScenarioStep } from "./types.js";
import { ensureCuratedProjectEntry, agentSuiteId } from "../testmind/curated-store.js";
import { emitSpecFile } from "../testmind/adapters/playwright-ts/generator.js";
import { PrismaClientKnownRequestError } from "@prisma/client/runtime/library.js";

const defaultCoverage: Prisma.InputJsonValue = {};

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

export async function runAgentForPage(userId: string, pageId: string) {
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
    const llm = await requestPageAnalysis({
      baseUrl: page.session.baseUrl,
      url: page.url,
      instructions: page.instructions ?? page.session.instructions ?? undefined,
      scan,
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

    await replaceScenarios(page.id, llm.scenarios);
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
  const files: Record<string, string> = {};
  const counters = new Map<string, number>();

  for (const scenario of opts.scenarios) {
    const caseData = scenarioToTestCase(scenario, opts.pageUrl, opts.pagePath);
    const baseName = scenarioSlug(scenario.title);
    const nextCount = (counters.get(baseName) ?? 0) + 1;
    counters.set(baseName, nextCount);
    const fileName =
      nextCount === 1 ? `${baseName}.spec.ts` : `${baseName}-${nextCount}.spec.ts`;
    const relPath = path.join("scenarios", slug, fileName).replace(/\\/g, "/");
    const content = emitSpecFile(opts.pagePath, [caseData] as any);
    for (const root of opts.roots) {
      const baseDir = path.join(root, "scenarios", slug);
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
  });
  if (!project) throw new Error("Project not found or not owned by user");

  await prisma.agentScenario.update({
    where: { id: scenario.id },
    data: { status: "attached", attachedProjectId: project.id },
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

  const suiteId = agentSuiteId(project.id);
  const { root } = ensureCuratedProjectEntry(suiteId, `Agent - ${project.name}`);
  const destRoots = [root];
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
    select: { id: true, name: true },
  });
  if (!project) {
    throw new PrismaClientKnownRequestError("Project not found or not owned by user", {
      code: "P2025",
      clientVersion: "prisma",
    });
  }

  const attached = await prisma.agentScenario.findMany({
    where: { attachedProjectId: project.id, status: "attached" },
    include: { page: { select: { path: true, url: true } } },
  });
  if (!attached.length) return { specPaths: [] };

  const suiteId = agentSuiteId(project.id);
  const { root } = ensureCuratedProjectEntry(suiteId, `Agent - ${project.name}`);
  const destRoots = [root];
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
