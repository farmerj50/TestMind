import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getAuth } from "@clerk/fastify";
import { Queue } from "bullmq";
import fs from "fs/promises";
import path from "path";
import {
  createAgentSession,
  listAgentSessions,
  getAgentSession,
  addAgentPage,
  runAgentForPage,
  attachScenarioToProject,
  getOrCreateProjectSession,
  getLatestSessionForProject,
  regenerateAttachedSpecs,
} from "../agent/service";
import { emitSpecFile } from "../testmind/adapters/playwright-ts/generator";
import { agentSuiteId, ensureCuratedProjectEntry } from "../testmind/curated-store";
import { prisma } from "../prisma";

type CoverageSummary = {
  coverageTotals: Record<string, number>;
  completedPages: number;
  failedPages: number;
  pageCount: number;
};

function summarizeCoverage(pages: Array<{ status: string; coverage: any }>): CoverageSummary {
  const coverageTotals: Record<string, number> = {};
  let completedPages = 0;
  let failedPages = 0;
  for (const p of pages) {
    if (p.status === "completed") completedPages++;
    if (p.status === "failed") failedPages++;
    const cov = (p as any).coverage;
    if (cov && typeof cov === "object") {
      for (const [k, v] of Object.entries(cov)) {
        if (typeof v === "number" && Number.isFinite(v)) {
          coverageTotals[k] = (coverageTotals[k] ?? 0) + v;
        }
      }
    }
  }
  return {
    coverageTotals,
    completedPages,
    failedPages,
    pageCount: pages.length,
  };
}

function requireUser(req: any, reply: any) {
  const { userId } = getAuth(req);
  if (!userId) {
    reply.code(401).send({ error: "Unauthorized" });
    return null;
  }
  return userId;
}

const SessionBody = z.object({
  baseUrl: z.string().url(),
  name: z.string().min(1).optional(),
  instructions: z.string().optional(),
  projectId: z.string().optional(),
});

const PageBody = z.object({
  path: z.string().optional(),
  url: z.string().optional(),
  instructions: z.string().optional(),
});

const ScanBody = z
  .object({
    baseUrl: z.string().url(),
    path: z.string().optional(),
    url: z.string().optional(),
    instructions: z.string().optional(),
  })
  .refine((val) => !!(val.path || val.url), {
    message: "path or url is required",
    path: ["url"],
  });

const AttachBody = z.object({
  projectId: z.string().optional(),
});

const ScenarioBody = z.object({
  title: z.string().min(1),
  coverageType: z.string().min(1),
  description: z.string().optional(),
  risk: z.string().optional(),
  tags: z.any().optional(),
});

const agentQueue = new Queue("agent-sessions", {
  connection: { url: process.env.REDIS_URL || "redis://127.0.0.1:6379" },
});

function registerProjectHelpers(
  app: FastifyInstance,
  base: string,
  requireUserFn: (req: any, reply: any) => string | null
) {
  app.get(`${base}/projects/:projectId/session`, async (req, reply) => {
    const userId = requireUserFn(req, reply);
    if (!userId) return;
    const { projectId } = req.params as { projectId: string };
    const session = await getLatestSessionForProject(userId, projectId);
    return reply.send({
      session: session
        ? {
            ...session,
            coverage: summarizeCoverage(session.pages || []),
          }
        : null,
    });
  });

  app.post(`${base}/projects/:projectId/scans`, async (req, reply) => {
    const userId = requireUserFn(req, reply);
    if (!userId) return;
    const { projectId } = req.params as { projectId: string };
    const parsed = ScanBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      const session = await getOrCreateProjectSession({
        userId,
        projectId,
        baseUrl: parsed.data.baseUrl,
        instructions: parsed.data.instructions,
      });
      const page = await addAgentPage(userId, session.id, {
        path: parsed.data.path,
        url: parsed.data.url,
        instructions: parsed.data.instructions,
      });
      const updated = await runAgentForPage(userId, page.id);
      return reply.send({ session: updated });
    } catch (err: any) {
      return reply.code(500).send({ error: err?.message ?? "Failed to start scan" });
    }
  });
}

export default async function agentRoutes(app: FastifyInstance) {
  app.get("/tm/agent/sessions", async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const sessions = await listAgentSessions(userId);
    return reply.send({
      sessions: sessions.map((s) => ({
        id: s.id,
        name: s.name,
        baseUrl: s.baseUrl,
        projectId: s.projectId,
        status: s.status,
        pageCount: s._count.pages,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        coverage: summarizeCoverage(s.pages),
      })),
    });
  });

  app.post("/tm/agent/sessions", async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const parsed = SessionBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const { baseUrl, name, projectId, instructions } = parsed.data;
    const session = await createAgentSession({
      userId,
      baseUrl,
      name,
      projectId,
      instructions,
    });
    return reply.code(201).send({ session });
  });

  app.get("/tm/agent/sessions/:id", async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const { id } = req.params as { id: string };
    const session = await getAgentSession(userId, id);
    if (!session) return reply.code(404).send({ error: "Session not found" });
    return reply.send({
      session: {
        ...session,
        coverage: summarizeCoverage(session.pages),
      },
    });
  });

  app.post("/tm/agent/sessions/:id/pages", async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const { id } = req.params as { id: string };
    const parsed = PageBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const page = await addAgentPage(userId, id, parsed.data);
    return reply.code(201).send({ page });
  });

  app.post("/tm/agent/sessions/:id/start", async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const { id } = req.params as { id: string };
    const session = await prisma.agentSession.findFirst({ where: { id, userId } });
    if (!session) return reply.code(404).send({ error: "Session not found" });
    await prisma.agentSession.update({
      where: { id: session.id },
      data: { status: "running" },
    });
    await agentQueue.add(
      "start-session",
      {
        sessionId: session.id,
        baseUrl: session.baseUrl,
        projectId: session.projectId,
        userId,
      },
      {
        jobId: session.id,
        attempts: 3,
        backoff: { type: "fixed", delay: 5000 },
        removeOnComplete: true,
        removeOnFail: false,
      }
    );
    const updated = await getAgentSession(userId, session.id);
    return reply.send({ session: updated });
  });

  app.post("/tm/agent/pages/:id/run", async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const { id } = req.params as { id: string };
    try {
      const session = await runAgentForPage(userId, id);
      return reply.send({ session });
    } catch (err: any) {
      return reply.code(500).send({ error: err?.message ?? "Failed to analyze page" });
    }
  });

  app.post("/tm/agent/scenarios/:id/attach", async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const { id } = req.params as { id: string };
    const parsed = AttachBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      const result = await attachScenarioToProject(userId, id, parsed.data.projectId);
      return reply.send({ attached: result });
    } catch (err: any) {
      return reply.code(400).send({ error: err?.message ?? "Failed to attach scenario" });
    }
  });

  app.post("/tm/agent/projects/:projectId/specs/regenerate", async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const { projectId } = req.params as { projectId: string };
    try {
      const res = await regenerateAttachedSpecs(userId, projectId);
      return reply.send(res);
    } catch (err: any) {
      return reply.code(400).send({ error: err?.message ?? "Failed to regenerate specs" });
    }
  });

  registerProjectHelpers(app, "/tm/agent", requireUser);
  registerProjectHelpers(app, "/agent", requireUser);

  // Public /agent prefixed routes (non /tm) to mirror spec
  app.get("/agent/sessions", async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const sessions = await listAgentSessions(userId);
    return reply.send({ sessions });
  });

  app.post("/agent/sessions", async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const parsed = SessionBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const { baseUrl, name, projectId, instructions } = parsed.data;
    const session = await createAgentSession({
      userId,
      baseUrl,
      name,
      projectId,
      instructions,
    });
    return reply.code(201).send({ session });
  });

  app.get("/agent/sessions/:id", async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const { id } = req.params as { id: string };
    const session = await getAgentSession(userId, id);
    if (!session) return reply.code(404).send({ error: "Session not found" });
    return reply.send({ session });
  });

  app.patch("/agent/sessions/:id", async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const { id } = req.params as { id: string };
    const data = req.body as any;
    const session = await prisma.agentSession.findFirst({ where: { id, userId } });
    if (!session) return reply.code(404).send({ error: "Session not found" });
    const updated = await prisma.agentSession.update({ where: { id }, data });
    return reply.send({ session: updated });
  });

  app.post("/agent/sessions/:id/start", async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const { id } = req.params as { id: string };
    const session = await prisma.agentSession.findFirst({ where: { id, userId } });
    if (!session) return reply.code(404).send({ error: "Session not found" });
    await prisma.agentSession.update({
      where: { id: session.id },
      data: { status: "running" },
    });
    await agentQueue.add(
      "start-session",
      {
        sessionId: session.id,
        baseUrl: session.baseUrl,
        projectId: session.projectId,
        userId,
      },
      {
        jobId: session.id,
        attempts: 3,
        backoff: { type: "fixed", delay: 5000 },
        removeOnComplete: true,
        removeOnFail: false,
      }
    );
    const updated = await getAgentSession(userId, session.id);
    return reply.send({ session: updated });
  });

  app.get("/agent/pages", async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const { sessionId } = (req.query ?? {}) as { sessionId?: string };
    const pages = await prisma.agentPage.findMany({
      where: { session: { userId }, ...(sessionId ? { sessionId } : {}) },
      include: { scenarios: true },
      orderBy: { createdAt: "asc" },
    });
    return reply.send({ pages });
  });

  app.get("/agent/pages/:id", async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const { id } = req.params as { id: string };
    const page = await prisma.agentPage.findFirst({
      where: { id, session: { userId } },
      include: { scenarios: true, session: true },
    });
    if (!page) return reply.code(404).send({ error: "Page not found" });
    return reply.send({ page });
  });

  app.patch("/agent/pages/:id", async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const { id } = req.params as { id: string };
    const data = req.body as any;
    const page = await prisma.agentPage.findFirst({ where: { id, session: { userId } } });
    if (!page) return reply.code(404).send({ error: "Page not found" });
    const updated = await prisma.agentPage.update({ where: { id }, data });
    return reply.send({ page: updated });
  });

  app.get("/agent/pages/:id/scenarios", async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const { id } = req.params as { id: string };
    const scenarios = await prisma.agentScenario.findMany({
      where: { page: { id, session: { userId } } },
      orderBy: { createdAt: "asc" },
    });
    return reply.send({ scenarios });
  });

  app.post("/agent/pages/:pageId/scenarios", async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const { pageId } = req.params as { pageId: string };
    const parsed = ScenarioBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const page = await prisma.agentPage.findFirst({ where: { id: pageId, session: { userId } } });
    if (!page) return reply.code(404).send({ error: "Page not found" });
    const scenario = await prisma.agentScenario.create({
      data: {
        pageId,
        title: parsed.data.title,
        coverageType: parsed.data.coverageType || "navigation",
        description: parsed.data.description,
        tags: parsed.data.tags as any,
        risk: parsed.data.risk,
      },
    });
    return reply.code(201).send({ scenario });
  });

  app.get("/agent/scenarios/:id", async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const { id } = req.params as { id: string };
    const scenario = await prisma.agentScenario.findFirst({
      where: { id, page: { session: { userId } } },
      include: { page: { include: { session: true } } },
    });
    if (!scenario) return reply.code(404).send({ error: "Scenario not found" });
    return reply.send({ scenario });
  });

  app.patch("/agent/scenarios/:id", async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const { id } = req.params as { id: string };
    const data = req.body as any;
    const scenario = await prisma.agentScenario.findFirst({ where: { id, page: { session: { userId } } } });
    if (!scenario) return reply.code(404).send({ error: "Scenario not found" });
    const updated = await prisma.agentScenario.update({ where: { id }, data });
    return reply.send({ scenario: updated });
  });

  app.post("/agent/scenarios/:id/generate-test", async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const { id } = req.params as { id: string };
    const scenario = await prisma.agentScenario.findFirst({
      where: { id, page: { session: { userId } } },
      include: { page: { include: { session: true } } },
    });
    if (!scenario) return reply.code(404).send({ error: "Scenario not found" });

    // Prefer attached project, otherwise fall back to session project
    const targetProjectId = scenario.attachedProjectId || scenario.page.session.projectId;
    if (!targetProjectId) {
      return reply.code(400).send({ error: "Attach scenario to a project first" });
    }

    const project = await prisma.project.findFirst({
      where: { id: targetProjectId, ownerId: userId },
    });
    if (!project) return reply.code(404).send({ error: "Project not found or not owned by user" });

    // Build a simple Playwright spec file for this scenario
    const slug = scenario.page.path === "/" ? "home" : scenario.page.path.replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "").toLowerCase() || "page";
    const fileName = `${scenario.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "scenario"}.spec.ts`;
    const relPath = `scenarios/${slug}/${fileName}`;

    const steps = (scenario.steps as any[]) || [];
    const content = emitSpecFile(scenario.page.path, [
      {
        id: scenario.id,
        name: scenario.title,
        group: { page: scenario.page.path },
        steps: steps.length
          ? steps
          : [
              { kind: "goto", url: scenario.page.url },
              { kind: "expect-visible", selector: "body" },
            ],
      },
    ] as any);

    // Write to curated root + local specs (if configured)
    const suiteId = agentSuiteId(project.id);
    const { root } = ensureCuratedProjectEntry(suiteId, `Agent - ${project.name}`);
    const destRoots = [root];
    if (process.env.TM_LOCAL_SPECS) destRoots.push(process.env.TM_LOCAL_SPECS);

    await Promise.all(
      destRoots.map(async (dest) => {
        const dir = path.join(dest, "scenarios", slug);
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(path.join(dir, fileName), content, "utf8");
      })
    );

    await prisma.agentScenario.update({
      where: { id },
      data: { specPath: relPath, status: "accepted", attachedProjectId: project.id },
    });

    return reply.send({ specPath: relPath });
  });
}
