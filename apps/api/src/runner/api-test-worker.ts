import { Worker } from "bullmq";
import { createRedisConnection } from "./redis.js";
import { prisma } from "../prisma.js";
import type { ApiTestRunPayload } from "./queue.js";
import { runApiTests } from "./api-test-service.js";
export const apiTestWorker = new Worker<ApiTestRunPayload>(
  "api-tests",
  async (job) => {
    try {
      await runApiTests(job.data);
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      console.error("[api-test-worker] run failed", { runId: job.data.runId, error: msg });
      await prisma.apiTestRun
        .update({
          where: { id: job.data.runId },
          data: { status: "failed", finishedAt: new Date(), error: msg },
        })
        .catch(() => {});
      throw err;
    }
  },
  // Workers need blocking commands, so BullMQ requires maxRetriesPerRequest: null -
  // createQueueRedisConnection (maxRetriesPerRequest: 1) is for producers/Queues only.
  { connection: createRedisConnection("api-tests") }
);
