import test from "node:test";
import assert from "node:assert/strict";
import { scheduleQueue, type ScheduleTriggerPayload } from "./queue.js";
import { registerScheduleJob, removeScheduleJob } from "./scheduler.js";

// Mocked at the BullMQ `.add()` call boundary (real Queue instance, no real cron waiting,
// no real Redis side effects left behind - `add` is monkey-patched for the duration of
// each test and always restored in `finally`).

test("registerScheduleJob passes the schedule's timezone through to BullMQ's repeat.tz option", async () => {
  const calls: any[] = [];
  const original = scheduleQueue.add.bind(scheduleQueue);
  (scheduleQueue as any).add = async (name: string, data: ScheduleTriggerPayload, opts: any) => {
    calls.push({ name, data, opts });
    return {} as any;
  };
  try {
    await registerScheduleJob("sched-1", "project-1", "0 2 * * *", "America/New_York");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].opts.repeat.pattern, "0 2 * * *");
    assert.equal(calls[0].opts.repeat.tz, "America/New_York");
    assert.equal(calls[0].opts.jobId, "sched-sched-1");
  } finally {
    (scheduleQueue as any).add = original;
  }
});

test("registerScheduleJob omits repeat.tz (passes undefined) when no timezone is configured - server-local behavior is unchanged", async () => {
  const calls: any[] = [];
  const original = scheduleQueue.add.bind(scheduleQueue);
  (scheduleQueue as any).add = async (name: string, data: ScheduleTriggerPayload, opts: any) => {
    calls.push({ name, data, opts });
    return {} as any;
  };
  try {
    await registerScheduleJob("sched-2", "project-1", "0 2 * * *");
    assert.equal(calls[0].opts.repeat.tz, undefined);
  } finally {
    (scheduleQueue as any).add = original;
  }
});

test("removeScheduleJob never throws even if the repeatable entry was never registered", async () => {
  await assert.doesNotReject(() => removeScheduleJob("sched-never-existed", "0 2 * * *"));
});
