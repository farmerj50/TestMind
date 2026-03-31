import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getAuth } from "@clerk/fastify";
import { prisma } from "../prisma.js";
import { encryptSecret } from "../lib/crypto.js";

const IntegrationBody = z.object({
  projectId: z.string().min(1),
  siteUrl: z.string().url(),
  email: z.string().email(),
  apiToken: z.string().min(1),
  projectKey: z.string().min(1),
});

function requireUser(req: any, reply: any) {
  const { userId } = getAuth(req);
  if (!userId) {
    reply.code(401).send({ error: "Unauthorized" });
    return null;
  }
  return userId;
}

async function ensureProjectOwner(projectId: string, userId: string) {
  const project = await prisma.project.findFirst({
    where: { id: projectId, ownerId: userId },
    select: { id: true, name: true },
  });
  if (!project) throw new Error("Project not found or not owned by user");
  return project;
}

function mockRequirements(projectKey: string, siteUrl: string) {
  const titles = [
    "User can submit an empty search query",
    "Search results show top stories card",
    "Voice search icon opens the correct dialog",
    "Autocomplete suggestions highlight the matching text",
    "Footer links navigate to legal pages",
  ];
  const statuses = ["To Do", "In Progress", "In Review", "Done"];
  const priorities = ["Low", "Medium", "High", "Critical"];
  const baseUrl = siteUrl.replace(/\/+$/, "");

  return titles.map((summary, index) => {
    const issueKey = `${projectKey}-${index + 1}`;
    return {
      issueKey,
      summary,
      status: statuses[index % statuses.length],
      priority: priorities[index % priorities.length],
      url: `${baseUrl}/browse/${issueKey}`,
    };
  });
}

export default async function jiraRoutes(app: FastifyInstance) {
  app.get("/integrations/jira", async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;

    const integrations = await prisma.jiraIntegration.findMany({
      where: { userId },
      include: {
        project: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: "desc" },
    });

    return reply.send({
      integrations: integrations.map((integration) => ({
        id: integration.id,
        projectId: integration.projectId,
        projectName: integration.project.name,
        siteUrl: integration.siteUrl,
        email: integration.email,
        projectKey: integration.projectKey,
        lastSyncedAt: integration.lastSyncedAt,
        createdAt: integration.createdAt,
      })),
    });
  });

  app.post("/integrations/jira", async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;

    const parsed = IntegrationBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      await ensureProjectOwner(parsed.data.projectId, userId);
    } catch (err: any) {
      return reply.code(404).send({ error: err?.message ?? "Project not found" });
    }

    const integration = await prisma.jiraIntegration.upsert({
      where: { userId_projectId: { userId, projectId: parsed.data.projectId } },
      update: {
        siteUrl: parsed.data.siteUrl,
        email: parsed.data.email,
        apiToken: encryptSecret(parsed.data.apiToken),
        projectKey: parsed.data.projectKey,
      },
      create: {
        userId,
        projectId: parsed.data.projectId,
        siteUrl: parsed.data.siteUrl,
        email: parsed.data.email,
        apiToken: encryptSecret(parsed.data.apiToken),
        projectKey: parsed.data.projectKey,
      },
    });

    return reply.code(201).send({
      integration: {
        id: integration.id,
        projectId: integration.projectId,
        siteUrl: integration.siteUrl,
        email: integration.email,
        projectKey: integration.projectKey,
        lastSyncedAt: integration.lastSyncedAt,
      },
    });
  });

  app.delete("/integrations/jira/:id", async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const { id } = req.params as { id: string };

    const integration = await prisma.jiraIntegration.findFirst({
      where: { id, userId },
    });
    if (!integration) {
      return reply.code(404).send({ error: "Integration not found" });
    }

    await prisma.jiraIntegration.delete({ where: { id } });
    return reply.code(204).send();
  });

  app.get("/integrations/jira/:id/requirements", async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const { id } = req.params as { id: string };

    const integration = await prisma.jiraIntegration.findFirst({
      where: { id, userId },
    });
    if (!integration) {
      return reply.code(404).send({ error: "Integration not found" });
    }

    const requirements = await prisma.jiraRequirement.findMany({
      where: { integrationId: id },
      orderBy: { syncedAt: "desc" },
    });

    return reply.send({ requirements });
  });

  app.post("/integrations/jira/:id/sync", async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const { id } = req.params as { id: string };

    const integration = await prisma.jiraIntegration.findFirst({
      where: { id, userId },
    });
    if (!integration) {
      return reply.code(404).send({ error: "Integration not found" });
    }

    const mockIssues = mockRequirements(integration.projectKey, integration.siteUrl);
    await prisma.$transaction(
      mockIssues.map((issue) =>
        prisma.jiraRequirement.upsert({
          where: {
            integrationId_issueKey: { integrationId: integration.id, issueKey: issue.issueKey },
          },
          update: {
            summary: issue.summary,
            status: issue.status,
            priority: issue.priority,
            url: issue.url,
            syncedAt: new Date(),
          },
          create: {
            integrationId: integration.id,
            issueKey: issue.issueKey,
            summary: issue.summary,
            status: issue.status,
            priority: issue.priority,
            url: issue.url,
          },
        })
      )
    );

    const updated = await prisma.jiraIntegration.update({
      where: { id },
      data: { lastSyncedAt: new Date() },
    });

    return reply.send({ ok: true, lastSyncedAt: updated.lastSyncedAt });
  });
}
