import type { FastifyInstance } from "fastify";
import { getAuth } from "@clerk/fastify";
import { z } from "zod";
import { prisma } from "../prisma.js";
import { enqueueSecurityScan } from "../runner/queue.js";
import {
  buildSecurityFindingDetail,
  buildSecurityRegressionTest,
} from "../lib/security-finding-detail.js";

function requireUser(req: any, reply: any) {
  const { userId } = getAuth(req);
  if (!userId) {
    reply.code(401).send({ error: "Unauthorized" });
    return null;
  }
  return userId;
}

const startSchema = z.object({
  projectId: z.string(),
  baseUrl: z.string(),
  allowedHosts: z.array(z.string()).default([]),
  allowedPorts: z.array(z.number()).default([80, 443]),
  maxDurationMinutes: z.number().int().min(1).max(60).default(10),
  enableActive: z.boolean().default(false),
});

export default async function securityRoutes(app: FastifyInstance) {
  app.post("/security/scans", async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;

    const parsed = startSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.message });
    }
    const body = parsed.data;

    const project = await prisma.project.findFirst({
      where: { id: body.projectId, ownerId: userId },
      select: { id: true },
    });
    if (!project) return reply.code(404).send({ error: "Project not found" });

    const job = await prisma.securityScanJob.create({
      data: {
        projectId: project.id,
        status: "queued",
        phase: null,
        config: {
          baseUrl: body.baseUrl,
          allowedHosts: body.allowedHosts,
          allowedPorts: body.allowedPorts,
          maxDurationMinutes: body.maxDurationMinutes,
          enableActive: body.enableActive,
        },
      },
    });

    await enqueueSecurityScan({
      jobId: job.id,
      projectId: project.id,
      baseUrl: body.baseUrl,
      allowedHosts: body.allowedHosts,
      allowedPorts: body.allowedPorts,
      maxDurationMinutes: body.maxDurationMinutes,
      enableActive: body.enableActive,
    });

    return { job };
  });

  app.get("/security/scans/:id", async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const { id } = req.params as { id: string };
    const job = await prisma.securityScanJob.findFirst({
      where: { id, project: { ownerId: userId } },
      include: {
        findings: {
          orderBy: { createdAt: "desc" },
        },
      },
    });
    if (!job) return reply.code(404).send({ error: "Not found" });
    return { job };
  });

  app.get("/security/scans", async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const projectId = (req.query as any)?.projectId as string | undefined;
    const jobs = await prisma.securityScanJob.findMany({
      where: {
        project: { ownerId: userId },
        ...(projectId ? { projectId } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: {
        id: true,
        projectId: true,
        status: true,
        phase: true,
        summary: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    return { jobs };
  });

  app.post("/security/findings/:id/explain", async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const { id } = req.params as { id: string };
    const finding = await prisma.securityFinding.findFirst({
      where: { id, scan: { project: { ownerId: userId } } },
    });
    if (!finding) return reply.code(404).send({ error: "Not found" });
    return { detail: buildSecurityFindingDetail(finding as any) };
  });

  app.post("/security/findings/:id/generate-test", async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const { id } = req.params as { id: string };
    const finding = await prisma.securityFinding.findFirst({
      where: { id, scan: { project: { ownerId: userId } } },
    });
    if (!finding) return reply.code(404).send({ error: "Not found" });
    return { test: buildSecurityRegressionTest(finding as any) };
  });
}
