/**
 * Journey 3 — QA Agent: Self-heal (Repair)
 *
 * Depends on Journey 2 (classify/triage). This journey validates the repair
 * leg: when a run has self-healable failures, the operator routes them to the
 * AI repair pipeline and the job eventually shows healed results.
 *
 * One QA job is started in beforeAll and shared across all tests.
 * The suite waits for terminal state once (up to J3_TIMEOUT ms), then each
 * test inspects the resulting UI — total run time equals one job execution.
 *
 * Env vars required:
 *   E2E_EMAIL   – TestMind account email
 *   E2E_PASS    – TestMind account password
 *
 * Optional:
 *   TM_BASE_URL – default http://localhost:5173
 *   J3_PROJECT  – project name hint (substring match)
 *   J3_SUITE    – suite name hint (substring match)
 *   J3_TIMEOUT  – ms to wait for job terminal state (default: 1800000 = 30 min,
 *                 covers run + triage + repair + validation)
 */

import { test, expect, type Page } from "@playwright/test";

const PROJECT_HINT = process.env.J3_PROJECT ?? process.env.J1_PROJECT ?? "";
const SUITE_HINT   = process.env.J3_SUITE   ?? process.env.J1_SUITE   ?? "";
const JOB_TIMEOUT  = Number(process.env.J3_TIMEOUT ?? "1800000");

async function pickFromSelect(page: Page, nth: number, hint: string) {
  const select = page.getByRole("combobox").nth(nth);
  await expect(select).toBeVisible({ timeout: 10_000 });
  const value = await select.evaluate((el, h) => {
    const opts = Array.from((el as HTMLSelectElement).options);
    if (h) {
      const match = opts.find((o) => o.text.toLowerCase().includes(h.toLowerCase()));
      return match?.value ?? opts[0]?.value ?? null;
    }
    return opts[0]?.value ?? null;
  }, hint);
  if (value) await select.selectOption(value);
}

// Shared state — populated by beforeAll, read by every test
let sharedPage: Page;
let terminalStatus: "succeeded" | "failed";
let hadFailures: boolean;
let hadSelfHealable: boolean;

test.describe("Journey 3 — Self-heal (Repair)", () => {
  test.setTimeout(JOB_TIMEOUT + 120_000);

  test.beforeAll(async ({ browser }) => {
    sharedPage = await browser.newPage();

    await sharedPage.goto("/qa-agent");
    await pickFromSelect(sharedPage, 0, PROJECT_HINT);
    await pickFromSelect(sharedPage, 1, SUITE_HINT);
    await sharedPage.getByRole("button", { name: /start qa agent/i }).click();

    // Wait for Job status card
    await expect(sharedPage.getByText("Job status")).toBeVisible({ timeout: 15_000 });

    // Wait for execute phase
    await expect(sharedPage.getByText("Run suite")).toBeVisible({ timeout: 30_000 });

    // Wait for terminal state — includes repair time so use full JOB_TIMEOUT
    const succeeded = sharedPage.getByText("succeeded");
    const failed    = sharedPage.getByText("failed");
    await expect(succeeded.or(failed).first()).toBeVisible({ timeout: JOB_TIMEOUT });

    terminalStatus = (await succeeded.first().isVisible().catch(() => false)) ? "succeeded" : "failed";

    hadFailures = terminalStatus === "failed" ||
      await sharedPage.getByText("Classify failures").isVisible({ timeout: 5_000 }).catch(() => false);

    hadSelfHealable = hadFailures &&
      await sharedPage.getByText(/\d+ self-heal/).isVisible({ timeout: 5_000 }).catch(() => false);
  });

  test.afterAll(async () => {
    await sharedPage.close();
  });

  // ── Journey 2 prerequisite checks ────────────────────────────────────────────

  test("triage task completes when failures exist", async () => {
    if (!hadFailures) {
      test.info().annotations.push({ type: "note", description: "Suite passed cleanly — triage not triggered. Correct." });
      await expect(sharedPage.getByText("Classify failures")).not.toBeVisible();
      return;
    }
    await expect(sharedPage.getByText("Classify failures")).toBeVisible();
    // Triage task itself must not have failed
    const triageRow = sharedPage.locator("div").filter({ hasText: "Classify failures" }).first();
    await expect(triageRow).not.toContainText("failed");
  });

  // ── Journey 3: repair pipeline ───────────────────────────────────────────────

  test("self-heal task appears when self-healable failures exist", async () => {
    if (!hadSelfHealable) {
      test.info().annotations.push({ type: "note", description: "No self-healable failures — repair not triggered. Correct." });
      await expect(sharedPage.getByText("Self-heal")).not.toBeVisible();
      return;
    }
    // The repair task row should be labelled "Self-heal"
    await expect(sharedPage.getByText("Self-heal")).toBeVisible({ timeout: 60_000 });
  });

  test("repair task reaches a terminal state — never stuck running", async () => {
    if (!hadSelfHealable) {
      test.skip(true, "No self-healable failures — repair task not created.");
      return;
    }
    const repairRow = sharedPage.locator("div").filter({ hasText: /^Self-heal/ }).first();
    await expect(repairRow).toBeVisible({ timeout: 60_000 });
    // Must be succeeded or failed, not running
    await expect(repairRow).not.toContainText("running");
  });

  test("job shows healed summary pill when repairs ran", async () => {
    if (!hadSelfHealable) {
      test.skip(true, "No self-healable failures — heal summary not expected.");
      return;
    }
    // The healed summary only appears when job.status === 'succeeded' AND triage had self-heal classifications
    if (terminalStatus !== "succeeded") {
      test.info().annotations.push({ type: "note", description: "Job ended in 'failed' — healed summary not shown. Acceptable when repair could not fix all failures." });
      return;
    }
    await expect(sharedPage.getByText(/tests? routed to self-heal/)).toBeVisible({ timeout: 10_000 });
  });

  test("job reaches terminal state — never stuck in running", async () => {
    expect(["succeeded", "failed"]).toContain(terminalStatus);
    await expect(sharedPage.getByRole("button", { name: /start qa agent/i })).toBeVisible();
    await expect(sharedPage.getByRole("button", { name: /running/i })).not.toBeVisible();
  });

  test("repair task does not resurrect archived test cases", async () => {
    // This test validates the DB-level fix: archived test cases (error-key artifacts)
    // must never appear as repair tasks. We verify indirectly — if any repair task
    // shows an error mentioning "No tests found" or "archived", the fix is broken.
    if (!hadSelfHealable) {
      test.skip(true, "No self-heal task to inspect.");
      return;
    }
    const repairRow = sharedPage.locator("div").filter({ hasText: /^Self-heal/ }).first();
    await expect(repairRow).not.toContainText("No tests found");
    await expect(repairRow).not.toContainText("archived");
  });
});
