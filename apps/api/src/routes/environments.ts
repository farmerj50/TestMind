import type { FastifyInstance } from "fastify";
import { prisma } from "../prisma.js";

export default async function environmentsRoutes(app: FastifyInstance) {
  app.get("/environments", async (req, reply) => {
    const { projectId } = req.query as { projectId?: string };
    if (!projectId) return reply.code(400).send({ error: "projectId required" });
    const environments = await prisma.environment.findMany({
      where: { projectId },
      orderBy: { name: "asc" },
    });
    return reply.send({ environments });
  });

  app.post("/environments", async (req, reply) => {
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
    const { id } = req.params as { id: string };
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
    const { id } = req.params as { id: string };
    await prisma.environment.delete({ where: { id } });
    return reply.code(204).send();
  });
}
