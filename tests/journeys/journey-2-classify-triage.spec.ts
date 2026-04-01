/**
 * Journey 2 — QA Agent: Classify & Triage
 *
 * One QA job is started in beforeAll and shared across all tests.
 * The suite waits for terminal state once, then each test inspects
 * the resulting UI — total run time equals one job execution, not N.
 *
 * Env vars required:
 *   E2E_EMAIL   – TestMind account email
 *   E2E_PASS    – TestMind account password
 *
 * Optional:
 *   TM_BASE_URL – default http://localhost:5173
 *   J2_PROJECT  – project name hint (substring match)
 *   J2_SUITE    – suite name hint (substring match)
 *   J2_TIMEOUT  – ms to wait for job terminal state (default: 1080000 = 18 min)
 */

import { test, expect, type Page } from "@playwright/test";

const PROJECT_HINT = process.env.J2_PROJECT ?? process.env.J1_PROJECT ?? "";
const SUITE_HINT   = process.env.J2_SUITE   ?? process.env.J1_SUITE   ?? "";
const JOB_TIMEOUT  = Number(process.env.J2_TIMEOUT ?? "1080000");

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

test.describe("Journey 2 — Classify & Triage", () => {
  test.setTimeout(JOB_TIMEOUT + 120_000);

  test.beforeAll(async ({ browser }) => {
    // One shared page, one shared job
    sharedPage = await browser.newPage();

    await sharedPage.goto("/qa-agent");
    await pickFromSelect(sharedPage, 0, PROJECT_HINT);
    await pickFromSelect(sharedPage, 1, SUITE_HINT);
    await sharedPage.getByRole("button", { name: /start qa agent/i }).click();

    // Wait for Job status card
    await expect(sharedPage.getByText("Job status")).toBeVisible({ timeout: 15_000 });

    // Wait for execute phase
    await expect(sharedPage.getByText("Run suite")).toBeVisible({ timeout: 30_000 });

    // Wait for terminal state
    const succeeded = sharedPage.getByText("succeeded");
    const failed    = sharedPage.getByText("failed");
    await expect(succeeded.or(failed).first()).toBeVisible({ timeout: JOB_TIMEOUT });

    terminalStatus = await succeeded.first().isVisible().catch(() => false) ? "succeeded" : "failed";
    hadFailures = terminalStatus === "failed" ||
      await sharedPage.getByText("Classify failures").isVisible({ timeout: 5_000 }).catch(() => false);
  });

  test.afterAll(async () => {
    await sharedPage.close();
  });

  test("triage task appears when run has failures", async () => {
    if (!hadFailures) {
      test.info().annotations.push({ type: "note", description: "Suite passed cleanly — Journey 2 skipped. Correct behaviour." });
      await expect(sharedPage.getByText("Classify failures")).not.toBeVisible();
      return;
    }
    await expect(sharedPage.getByText("Classify failures")).toBeVisible();
  });

  test("each failure gets a classification pill (self-heal / defect / blocked)", async () => {
    if (!hadFailures) {
      test.skip(true, "No failures — classification not triggered.");
      return;
    }
    const selfHeal = sharedPage.getByText(/\d+ self-heal/);
    const defect   = sharedPage.getByText(/\d+ defect/);
    const blocked  = sharedPage.getByText(/\d+ blocked/);
    const any = await selfHeal.or(defect).or(blocked).first().isVisible().catch(() => false);
    expect(any, "At least one classification pill must be visible").toBe(true);
  });

  test("self-healable failures are routed to repair task", async () => {
    if (!hadFailures) {
      test.skip(true, "No failures — self-heal routing not triggered.");
      return;
    }
    const hasSelfHeal = await sharedPage.getByText(/\d+ self-heal/).isVisible().catch(() => false);
    if (!hasSelfHeal) {
      test.info().annotations.push({ type: "note", description: "No self-healable failures — repair not triggered. Correct." });
      return;
    }
    await expect(sharedPage.getByText("Self-heal")).toBeVisible({ timeout: 60_000 });
  });

  test("product defects are recorded with dev routing hint", async () => {
    if (!hadFailures) {
      test.skip(true, "No failures — defect task not created.");
      return;
    }
    const hasDefects = await sharedPage.getByText(/\d+ defect/).isVisible().catch(() => false);
    if (!hasDefects) {
      test.info().annotations.push({ type: "note", description: "No product defects classified. Correct." });
      return;
    }
    await expect(sharedPage.getByText(/→ dev/)).toBeVisible();
  });

  test("triage task status is succeeded — classification never fails", async () => {
    if (!hadFailures) return; // no triage task exists
    const triageRow = sharedPage.locator("div").filter({ hasText: "Classify failures" }).first();
    await expect(triageRow).not.toContainText("failed");
  });

  test("job reaches terminal state — never stuck in running", async () => {
    expect(["succeeded", "failed"]).toContain(terminalStatus);
    await expect(sharedPage.getByRole("button", { name: /start qa agent/i })).toBeVisible();
    await expect(sharedPage.getByRole("button", { name: /running/i })).not.toBeVisible();
  });
});
