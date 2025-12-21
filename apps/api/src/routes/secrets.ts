import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getAuth } from "@clerk/fastify";
import { prisma } from "../prisma.js";
import { encryptSecret } from "../lib/crypto.js";

const CreateBody = z.object({
  name: z.string().trim().min(1).max(128),
  key: z.string().regex(/^[A-Z0-9_]{1,64}$/),
  value: z.string().min(1),
});

const UpdateBody = z.object({
  name: z.string().trim().min(1).max(128).optional(),
  key: z.string().regex(/^[A-Z0-9_]{1,64}$/).optional(),
  value: z.string().min(1).optional(),
});

async function isProjectOwner(projectId: string, userId: string) {
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { ownerId: true } });
  if (!project) return false;
  return project.ownerId === userId;
}

export async function secretsRoutes(app: FastifyInstance) {
  app.get("/projects/:projectId/secrets", async (req, reply) => {
    const { userId } = getAuth(req);
    if (!userId) return reply.code(401).send({ error: "Unauthorized" });
    const { projectId } = req.params as { projectId: string };
    if (!(await isProjectOwner(projectId, userId))) return reply.code(403).send({ error: "Forbidden" });

    const secrets = await prisma.projectSecret.findMany({
      where: { projectId },
      select: { id: true, name: true, key: true, createdAt: true, updatedAt: true },
      orderBy: { createdAt: "asc" },
    });

    return reply.send({ secrets });
  });

  app.post("/projects/:projectId/secrets", async (req, reply) => {
    const { userId } = getAuth(req);
    if (!userId) return reply.code(401).send({ error: "Unauthorized" });
    const { projectId } = req.params as { projectId: string };
    if (!(await isProjectOwner(projectId, userId))) return reply.code(403).send({ error: "Forbidden" });

    const parsed = CreateBody.safeParse(req.body);
    if (!parsed.success) return reply.code(422).send({ error: parsed.error.flatten() });
    const { name, key, value } = parsed.data;

    const secret = await prisma.projectSecret.create({
      data: { projectId, name, key, value: encryptSecret(value) },
      select: { id: true, name: true, key: true, createdAt: true, updatedAt: true },
    });
    return reply.code(201).send({ secret });
  });

  app.put("/projects/:projectId/secrets/:id", async (req, reply) => {
    const { userId } = getAuth(req);
    if (!userId) return reply.code(401).send({ error: "Unauthorized" });
    const { projectId, id } = req.params as { projectId: string; id: string };
    if (!(await isProjectOwner(projectId, userId))) return reply.code(403).send({ error: "Forbidden" });

    const parsed = UpdateBody.safeParse(req.body);
    if (!parsed.success) return reply.code(422).send({ error: parsed.error.flatten() });

    const data: Record<string, any> = {};
    if (parsed.data.name) data.name = parsed.data.name;
    if (parsed.data.key) data.key = parsed.data.key;
    if (parsed.data.value) data.value = encryptSecret(parsed.data.value);

    const secret = await prisma.projectSecret.update({
      where: { id },
      data,
      select: { id: true, name: true, key: true, createdAt: true, updatedAt: true },
    });
    return reply.send({ secret });
  });

  app.delete("/projects/:projectId/secrets/:id", async (req, reply) => {
    const { userId } = getAuth(req);
    if (!userId) return reply.code(401).send({ error: "Unauthorized" });
    const { projectId, id } = req.params as { projectId: string; id: string };
    if (!(await isProjectOwner(projectId, userId))) return reply.code(403).send({ error: "Forbidden" });

    await prisma.projectSecret.delete({ where: { id } });
    return reply.code(204).send();
  });
}
