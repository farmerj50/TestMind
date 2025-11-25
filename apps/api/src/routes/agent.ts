import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getAuth } from "@clerk/fastify";
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
} from "../agent/service.js";

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
    const session = await createAgentSession({ userId, ...parsed.data });
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
}
