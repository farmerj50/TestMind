import type { FastifyInstance } from "fastify";
import { getAuth } from "@clerk/fastify";
import { prisma } from "../prisma.js";
import { registerScheduleJob, removeScheduleJob } from "../runner/scheduler.js";

// Minimal cron validation — 5 space-separated fields
function isValidCron(cron: string): boolean {
  return /^(\S+\s+){4}\S+$/.test(cron.trim());
}

export default async function schedulesRoutes(app: FastifyInstance) {
  app.post("/schedules", async (req, reply) => {
    const { userId } = getAuth(req);
    if (!userId) return reply.code(401).send({ error: "Unauthorized" });

    const { projectId, cron, contextJson = {} } = (req.body ?? {}) as {
      projectId?: string;
      cron?: string;
      contextJson?: object;
    };

    if (!projectId) return reply.code(400).send({ error: "projectId required" });
    if (!cron) return reply.code(400).send({ error: "cron required" });
    if (!isValidCron(cron)) return reply.code(400).send({ error: "Invalid cron expression (needs 5 fields)" });

    const project = await prisma.project.findUnique({ where: { id: projectId }, select: { ownerId: true } });
    if (!project) return reply.code(404).send({ error: "Project not found" });
    if (project.ownerId !== userId) return reply.code(403).send({ error: "Forbidden" });

    const schedule = await prisma.operatorSchedule.create({
      data: { projectId, cron: cron.trim(), enabled: true, contextJson: contextJson as any },
    });

    await registerScheduleJob(schedule.id, schedule.projectId, schedule.cron);

    return reply.code(201).send({ schedule });
  });

  app.get("/schedules", async (req, reply) => {
    const { userId } = getAuth(req);
    if (!userId) return reply.code(401).send({ error: "Unauthorized" });

    const { projectId } = req.query as { projectId?: string };
    if (!projectId) return reply.code(400).send({ error: "projectId required" });

    const project = await prisma.project.findUnique({ where: { id: projectId }, select: { ownerId: true } });
    if (!project) return reply.code(404).send({ error: "Project not found" });
    if (project.ownerId !== userId) return reply.code(403).send({ error: "Forbidden" });

    const schedules = await prisma.operatorSchedule.findMany({
      where: { projectId },
      orderBy: { createdAt: "asc" },
    });

    return reply.send({ schedules });
  });

  app.patch("/schedules/:id", async (req, reply) => {
    const { userId } = getAuth(req);
    if (!userId) return reply.code(401).send({ error: "Unauthorized" });

    const { id } = req.params as { id: string };
    const { enabled, cron } = (req.body ?? {}) as { enabled?: boolean; cron?: string };

    const schedule = await prisma.operatorSchedule.findUnique({
      where: { id },
      include: { project: { select: { ownerId: true } } },
    });
    if (!schedule) return reply.code(404).send({ error: "Schedule not found" });
    if (schedule.project.ownerId !== userId) return reply.code(403).send({ error: "Forbidden" });

    if (cron !== undefined && !isValidCron(cron)) {
      return reply.code(400).send({ error: "Invalid cron expression" });
    }

    // Remove old BullMQ entry before applying changes
    await removeScheduleJob(id, schedule.cron);

    const updated = await prisma.operatorSchedule.update({
      where: { id },
      data: {
        ...(enabled !== undefined ? { enabled } : {}),
        ...(cron !== undefined ? { cron: cron.trim() } : {}),
      },
    });

    // Re-register if still enabled
    if (updated.enabled) {
      await registerScheduleJob(updated.id, updated.projectId, updated.cron);
    }

    return reply.send({ schedule: updated });
  });

  app.delete("/schedules/:id", async (req, reply) => {
    const { userId } = getAuth(req);
    if (!userId) return reply.code(401).send({ error: "Unauthorized" });

    const { id } = req.params as { id: string };

    const schedule = await prisma.operatorSchedule.findUnique({
      where: { id },
      include: { project: { select: { ownerId: true } } },
    });
    if (!schedule) return reply.code(404).send({ error: "Schedule not found" });
    if (schedule.project.ownerId !== userId) return reply.code(403).send({ error: "Forbidden" });

    await removeScheduleJob(id, schedule.cron);
    await prisma.operatorSchedule.delete({ where: { id } });

    return reply.code(204).send();
  });
}
