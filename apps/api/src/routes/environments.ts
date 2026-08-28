import type { FastifyInstance } from "fastify";
import { getAuth } from "@clerk/fastify";
import { prisma } from "../prisma.js";
import { isProjectOwner } from "../lib/project-access.js";

export default async function environmentsRoutes(app: FastifyInstance) {
  app.get("/environments", async (req, reply) => {
    const { userId } = getAuth(req);
    if (!userId) return reply.code(401).send({ error: "Unauthorized" });
    const { projectId } = req.query as { projectId?: string };
    if (!projectId) return reply.code(400).send({ error: "projectId required" });
    if (!(await isProjectOwner(projectId, userId))) return reply.code(403).send({ error: "Forbidden" });

    const environments = await prisma.environment.findMany({
      where: { projectId },
      orderBy: { name: "asc" },
    });
    return reply.send({ environments });
  });

  app.post("/environments", async (req, reply) => {
    const { userId } = getAuth(req);
    if (!userId) return reply.code(401).send({ error: "Unauthorized" });
    const { projectId, name, baseUrl, variables, isProtected, requiresApproval } = (req.body ?? {}) as {
      projectId?: string;
      name?: string;
      baseUrl?: string;
      variables?: unknown;
      isProtected?: boolean;
      requiresApproval?: boolean;
    };
    if (!projectId || !name || !baseUrl) {
      return reply.code(400).send({ error: "projectId, name, baseUrl required" });
    }
    if (!(await isProjectOwner(projectId, userId))) return reply.code(403).send({ error: "Forbidden" });

    const environment = await prisma.environment.create({
      data: {
        projectId,
        name,
        baseUrl,
        variables: (variables ?? null) as any,
        isProtected: isProtected ?? false,
        requiresApproval: requiresApproval ?? false,
      },
    });
    return reply.code(201).send({ environment });
  });

  app.put("/environments/:id", async (req, reply) => {
    const { userId } = getAuth(req);
    if (!userId) return reply.code(401).send({ error: "Unauthorized" });
    const { id } = req.params as { id: string };
    const existing = await prisma.environment.findUnique({ where: { id }, select: { projectId: true } });
    if (!existing) return reply.code(404).send({ error: "Environment not found" });
    if (!(await isProjectOwner(existing.projectId, userId))) return reply.code(403).send({ error: "Forbidden" });

    const { name, baseUrl, variables, isProtected, requiresApproval } = (req.body ?? {}) as {
      name?: string;
      baseUrl?: string;
      variables?: unknown;
      isProtected?: boolean;
      requiresApproval?: boolean;
    };
    const environment = await prisma.environment.update({
      where: { id },
      data: {
        ...(name !== undefined ? { name } : {}),
        ...(baseUrl !== undefined ? { baseUrl } : {}),
        ...(variables !== undefined ? { variables: variables as any } : {}),
        ...(isProtected !== undefined ? { isProtected } : {}),
        ...(requiresApproval !== undefined ? { requiresApproval } : {}),
      },
    });
    return reply.send({ environment });
  });

  app.delete("/environments/:id", async (req, reply) => {
    const { userId } = getAuth(req);
    if (!userId) return reply.code(401).send({ error: "Unauthorized" });
    const { id } = req.params as { id: string };
    const existing = await prisma.environment.findUnique({ where: { id }, select: { projectId: true } });
    if (!existing) return reply.code(404).send({ error: "Environment not found" });
    if (!(await isProjectOwner(existing.projectId, userId))) return reply.code(403).send({ error: "Forbidden" });

    await prisma.environment.delete({ where: { id } });
    return reply.code(204).send();
  });
}
