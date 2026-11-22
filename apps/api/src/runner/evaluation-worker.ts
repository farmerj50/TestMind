import { Worker } from "bullmq";
import { createRedisConnection } from "./redis.js";
import { prisma } from "../prisma.js";
import type { EvaluationRunPayload } from "./queue.js";
import { runEvaluation } from "./evaluation-service.js";
export const evaluationWorker = new Worker<EvaluationRunPayload>(
  "evaluation-runs",
  async (job) => {
    try {
      await runEvaluation(job.data);
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      console.error("[evaluation-worker] run failed", { runId: job.data.runId, error: msg });
      await prisma.evaluationRun
        .update({
          where: { id: job.data.runId },
          data: { status: "failed", finishedAt: new Date(), error: msg },
        })
        .catch(() => {});
      throw err;
    }
  },
  { connection: createRedisConnection("evaluation-runs") }
);
