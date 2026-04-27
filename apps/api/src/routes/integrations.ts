import type { FastifyInstance } from "fastify";
import { getAuth } from "@clerk/fastify";
import { z } from "zod";
import { prisma } from "../prisma.js";
import { Prisma } from "@prisma/client";
import {
  assertProvider,
  integrationProviders,
} from "../integrations/registry.js";
import { encryptSecret } from "../lib/crypto.js";

const ListQuery = z.object({
  projectId: z.string().min(1),
});

const UpsertBody = z.object({
  id: z.string().optional(),
  projectId: z.string().min(1),
  provider: z.string().min(1),
  name: z.string().optional(),
  config: z.record(z.any()).optional(),
  secrets: z.record(z.any()).optional(),
  enabled: z.boolean().optional(),
});

export default async function integrationsRoutes(app: FastifyInstance) {
  app.get("/integrations", async (req, reply) => {
    const { userId } = getAuth(req);
    if (!userId) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
    const parsed = ListQuery.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(422).send({ error: parsed.error.flatten() });
    }
    const project = await prisma.project.findUnique({
      where: { id: parsed.data.projectId },
    });
    if (!project) {
      return reply.code(404).send({ error: "Project not found" });
    }
    if (project.ownerId !== userId) {
      return reply.code(403).send({ error: "Forbidden" });
    }
    const integrations = await prisma.integration.findMany({
      where: { projectId: project.id },
      orderBy: { createdAt: "asc" },
    });
    const response = integrations.map((integration) => {
      const provider = integrationProviders[integration.provider];
      const masked =
        provider?.maskConfig?.(integration.config ?? null) ??
        integration.config;
      return {
        id: integration.id,
        projectId: integration.projectId,
        provider: integration.provider,
        name: integration.name,
        config: masked,
        enabled: integration.enabled,
        createdAt: integration.createdAt,
        updatedAt: integration.updatedAt,
      };
    });
    return reply.send({ projectId: project.id, integrations: response });
  });

  app.post("/integrations", async (req, reply) => {
    const { userId } = getAuth(req);
    if (!userId) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
    const parsed = UpsertBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(422).send({ error: parsed.error.flatten() });
    }
    const body = parsed.data;
    const provider = assertProvider(body.provider);
    const project = await prisma.project.findUnique({
      where: { id: body.projectId },
    });
    if (!project) {
      return reply.code(404).send({ error: "Project not found" });
    }
    if (project.ownerId !== userId) {
      return reply.code(403).send({ error: "Forbidden" });
    }
    const validated = provider.validateConfig
      ? provider.validateConfig({ ...(body.config ?? {}), _projectId: project.id })
      : { config: body.config ?? {} };
    let targetId = body.id ?? null;
    if (!targetId && provider.allowMultiple !== true) {
      const existing = await prisma.integration.findFirst({
        where: { projectId: project.id, provider: provider.key },
      });
      if (existing) {
        targetId = existing.id;
      }
    }
    const integration = targetId
      ? await prisma.integration.update({
          where: { id: targetId },
            data: {
              name: body.name ?? provider.displayName,
            config: (validated.config as Prisma.InputJsonValue) ?? Prisma.JsonNull,
            secrets: (validated as any).secrets ?? body.secrets ?? undefined,
            enabled: body.enabled ?? true,
          },
        })
      : await prisma.integration.create({
          data: {
            projectId: project.id,
            provider: provider.key,
            name: body.name ?? provider.displayName,
            config: (validated.config as Prisma.InputJsonValue) ?? Prisma.JsonNull,
            secrets: (validated as any).secrets ?? body.secrets ?? undefined,
            enabled: body.enabled ?? true,
          },
        });
    const rawToken = (validated as any)._rawToken as string | undefined;
    if (rawToken) {
      await prisma.projectSecret.upsert({
        where: { projectId_key: { projectId: project.id, key: "jenkins_api_token" } },
        create: {
          projectId: project.id,
          name: "Jenkins API Token",
          key: "jenkins_api_token",
          value: encryptSecret(rawToken),
        },
        update: { value: encryptSecret(rawToken) },
      });
    }

    const masked =
      provider.maskConfig?.(integration.config ?? null) ??
      integration.config;
    return reply.send({
      integration: {
        id: integration.id,
        projectId: integration.projectId,
        provider: integration.provider,
        name: integration.name,
        config: masked,
        enabled: integration.enabled,
        createdAt: integration.createdAt,
        updatedAt: integration.updatedAt,
      },
      ...(rawToken ? { token: rawToken } : {}),
    });
  });

  app.post("/integrations/:id/actions/:action", async (req, reply) => {
    const { userId } = getAuth(req);
    if (!userId) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
    const { id, action } = req.params as { id: string; action: string };
    const integration = await prisma.integration.findUnique({
      where: { id },
      include: { project: true },
    });
    if (!integration) {
      return reply.code(404).send({ error: "Integration not found" });
    }
    if (integration.project.ownerId !== userId) {
      return reply.code(403).send({ error: "Forbidden" });
    }
    const provider = integrationProviders[integration.provider];
    if (!provider || !provider.performAction) {
      return reply
        .code(400)
        .send({ error: "ACTION_NOT_SUPPORTED", provider: integration.provider });
    }
    try {
      const result = await provider.performAction(action, {
        req,
        integration,
        payload: (req.body ?? {}) as any,
        userId,
      });
      return reply.send(result ?? { ok: true });
    } catch (err: any) {
      return reply.code(400).send({
        error: "ACTION_FAILED",
        message: err?.message ?? "Integration action failed",
      });
    }
  });

  app.delete("/integrations/:id", async (req, reply) => {
    const { userId } = getAuth(req);
    if (!userId) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
    const { id } = req.params as { id: string };
    const integration = await prisma.integration.findUnique({
      where: { id },
      include: { project: true },
    });
    if (!integration) {
      return reply.code(404).send({ error: "Integration not found" });
    }
    if (integration.project.ownerId !== userId) {
      return reply.code(403).send({ error: "Forbidden" });
    }
    if (integration.provider === "jenkins") {
      await prisma.projectSecret.deleteMany({
        where: { projectId: integration.projectId, key: "jenkins_api_token" },
      });
    }
    await prisma.integration.delete({ where: { id } });
    return reply.send({ ok: true });
  });
}
