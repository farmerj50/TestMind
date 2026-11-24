import test from "node:test";
import assert from "node:assert/strict";
import { finalizeRepairVerification, isRepairFailed, REPAIR_FAILED, verificationPassed } from "./repair-verification.js";

function fakeDb(rows: Array<{ id: string; status: string; error?: string | null; executionAfter?: unknown }>) {
  return {
    rows,
    testHealingAttempt: {
      async updateMany({ where, data }: { where: any; data: any }) {
        let count = 0;
        for (const r of rows) {
          if (!where.id.in.includes(r.id) || !where.status.in.includes(r.status)) continue;
          Object.assign(r, data);
          count++;
        }
        return { count };
      },
    },
  };
}

test("only a passing verification rerun counts as success", () => {
  assert.equal(verificationPassed({ passed: 1, failed: 0 }), true);
  assert.equal(verificationPassed({ passed: 0, failed: 1 }), false, "the certification case: patch applied, rerun failed");
  assert.equal(verificationPassed({ passed: 3, failed: 1 }), false);
  assert.equal(verificationPassed({ passed: 2, failed: 0, errors: 1 }), false);
  assert.equal(verificationPassed({ passed: 0, failed: 0, total: 0 }), false, "nothing executed is not verification");
  assert.equal(verificationPassed(null), false);
});

test("a failed rerun records repair_failed on the attempt; a passing one records success", async () => {
  const db = fakeDb([{ id: "a1", status: "succeeded" }, { id: "a2", status: "succeeded" }]);
  assert.equal(await finalizeRepairVerification(db, ["a1"], { passed: 0, failed: 1, total: 1 }), REPAIR_FAILED);
  assert.equal(db.rows[0].status, "failed");
  assert.ok(isRepairFailed(db.rows[0].error), db.rows[0].error ?? "");
  assert.match(db.rows[0].error!, /0 passed, 1 failed/);
  assert.deepEqual(db.rows[0].executionAfter, { passed: 0, failed: 1, total: 1 });

  assert.equal(await finalizeRepairVerification(db, ["a2"], { passed: 1, failed: 0, total: 1 }), "succeeded");
  assert.equal(db.rows[1].status, "succeeded");
  assert.equal(db.rows[1].error, null);
});

test("a rerun that did not complete is repair_failed even with a passing partial summary", async () => {
  const db = fakeDb([{ id: "a1", status: "succeeded" }]);
  assert.equal(await finalizeRepairVerification(db, ["a1"], { passed: 1, failed: 0 }, { runSucceeded: false, detail: "rerun timed out" }), REPAIR_FAILED);
  assert.equal(db.rows[0].error, `${REPAIR_FAILED}: rerun timed out`);
});

test("finalizing never resurrects an attempt that already failed or was skipped", async () => {
  const db = fakeDb([{ id: "a1", status: "failed", error: "LLM error" }, { id: "a2", status: "skipped" }]);
  await finalizeRepairVerification(db, ["a1", "a2"], { passed: 1, failed: 0 });
  assert.equal(db.rows[0].status, "failed");
  assert.equal(db.rows[0].error, "LLM error");
  assert.equal(db.rows[1].status, "skipped");
});
