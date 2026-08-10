import { Worker } from "bullmq";
import { prisma } from "../prisma.js";
import { scheduleQueue, enqueueOperatorJob, type ScheduleTriggerPayload } from "./queue.js";
import { redis } from "./redis.js";

export async function startScheduler(): Promise<void> {
  const schedules = await prisma.operatorSchedule.findMany({ where: { enabled: true } });

  for (const s of schedules) {
    await scheduleQueue.add(
      "scheduled-trigger",
      { scheduleId: s.id, projectId: s.projectId },
      { repeat: { pattern: s.cron }, jobId: `sched-${s.id}` }
    );
  }

  if (schedules.length) {
    console.log(`[scheduler] registered ${schedules.length} schedule(s)`);
  }

  // Worker that fires when a repeatable schedule job runs
  const worker = new Worker<ScheduleTriggerPayload>(
    "schedule-trigger",
    async (job) => {
      const { scheduleId, projectId } = job.data;

      const schedule = await prisma.operatorSchedule.findUnique({ where: { id: scheduleId } });
      if (!schedule || !schedule.enabled) return;

      const project = await prisma.project.findUnique({ where: { id: projectId }, select: { ownerId: true } });
      if (!project) return;

      const opJob = await prisma.operatorJob.create({
        data: {
          projectId,
          type: "qa",
          objective: `Scheduled run (${schedule.cron})`,
          requestedBy: project.ownerId,
          contextJson: {
            triggeredBy: "schedule",
            scheduleId,
            autonomous: true,
            ...(schedule.contextJson as object),
          },
        },
      });

      await prisma.operatorSchedule.update({
        where: { id: scheduleId },
        data: { lastRunAt: new Date() },
      });

      await enqueueOperatorJob(opJob.id);
    },
    { connection: redis }
  );

  worker.on("failed", (job, err) => {
    console.error(`[scheduler] job ${job?.id} failed:`, err);
  });
}

/** Register or update the repeatable entry for a single schedule. */
export async function registerScheduleJob(scheduleId: string, projectId: string, cron: string): Promise<void> {
  await scheduleQueue.add(
    "scheduled-trigger",
    { scheduleId, projectId },
    { repeat: { pattern: cron }, jobId: `sched-${scheduleId}` }
  );
}

/** Remove the repeatable entry for a single schedule. */
export async function removeScheduleJob(scheduleId: string, cron: string): Promise<void> {
  try {
    await scheduleQueue.removeRepeatable("scheduled-trigger", { pattern: cron }, `sched-${scheduleId}`);
  } catch {
    // ignore if not registered
  }
}
