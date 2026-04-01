/**
 * Journey 1 — QA Agent: Execute
 *
 * Tests the first leg of the QA operator pipeline:
 *   Sign in → Select project + suite → Start QA job
 *   → Execute task appears → Job reaches terminal state
 *
 * Env vars required:
 *   E2E_EMAIL    – TestMind account email
 *   E2E_PASS     – TestMind account password
 *
 * Optional:
 *   TM_BASE_URL  – default http://localhost:5173
 *   J1_PROJECT   – project name to select (substring match, default: first)
 *   J1_SUITE     – suite name to select (substring match, default: first)
 *   J1_TIMEOUT   – ms to wait for job terminal state (default: 300000 = 5 min)
 */

import { test, expect } from "@playwright/test";

const PROJECT_HINT = process.env.J1_PROJECT ?? "";
const SUITE_HINT   = process.env.J1_SUITE   ?? "";
const JOB_TIMEOUT  = Number(process.env.J1_TIMEOUT ?? "1080000"); // 18 min default — covers 15 min operator deadline + buffer

/**
 * Pick from a native <select> (combobox).
 * If hint is provided, finds the option whose text contains the hint.
 * Otherwise selects by index 0.
 */
async function pickFromSelect(
  page: import("@playwright/test").Page,
  nth: number,
  hint: string,
) {
  const select = page.getByRole("combobox").nth(nth);
  await expect(select).toBeVisible({ timeout: 10_000 });

  if (hint) {
    // Evaluate inside page to find matching option value
    const value = await select.evaluate((el, h) => {
      const opts = Array.from((el as HTMLSelectElement).options);
      const match = opts.find((o) => o.text.toLowerCase().includes(h.toLowerCase()));
      return match?.value ?? null;
    }, hint);
    if (value) await select.selectOption(value);
  } else {
    // Select first option (index 0 is already default, just confirm it's set)
    const value = await select.evaluate((el) =>
      (el as HTMLSelectElement).options[0]?.value ?? null
    );
    if (value) await select.selectOption(value);
  }
}

test.describe("Journey 1 — QA Execute", () => {
  // Auth is injected via storageState from auth.setup.mjs — no beforeEach needed.

  test("can navigate to the QA Agent page", async ({ page }) => {
    await page.goto("/qa-agent");
    await expect(page.getByRole("heading", { name: /autonomous qa execution/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /start qa agent/i })).toBeVisible();
  });

  test("project and suite selects are populated", async ({ page }) => {
    await page.goto("/qa-agent");

    // Wait for projects API call to complete — the select's value changes from empty to a real id
    const projectSelect = page.getByRole("combobox").first();
    await expect(projectSelect).toBeVisible({ timeout: 10_000 });

    // Poll until the select has at least one option with a real value
    await expect(async () => {
      const count = await projectSelect.evaluate(
        (el) => (el as HTMLSelectElement).options.length
      );
      expect(count).toBeGreaterThan(0);
    }).toPass({ timeout: 10_000, intervals: [500] });

    const suiteSelect = page.getByRole("combobox").nth(1);
    await expect(async () => {
      const count = await suiteSelect.evaluate(
        (el) => (el as HTMLSelectElement).options.length
      );
      expect(count).toBeGreaterThan(0);
    }).toPass({ timeout: 10_000, intervals: [500] });
  });

  test("starting a QA job creates an execute task (Journey 1)", async ({ page }) => {
    test.setTimeout(JOB_TIMEOUT + 60_000);
    await page.goto("/qa-agent");

    // ── Select project + suite ────────────────────────────────────────────────
    await pickFromSelect(page, 0, PROJECT_HINT);
    await pickFromSelect(page, 1, SUITE_HINT);

    // ── Launch ────────────────────────────────────────────────────────────────
    const startBtn = page.getByRole("button", { name: /start qa agent/i });
    await expect(startBtn).toBeEnabled();
    await startBtn.click();

    // ── Job status card appears ───────────────────────────────────────────────
    await expect(page.getByText("Job status")).toBeVisible({ timeout: 15_000 });

    // ── Execute phase (Journey 1) task row appears ────────────────────────────
    await expect(page.getByText("Execution phases")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("Run suite")).toBeVisible({ timeout: 30_000 });

    // ── Wait for job to reach terminal state ──────────────────────────────────
    const succeeded = page.getByText("succeeded");
    const failed    = page.getByText("failed");
    await expect(succeeded.or(failed).first()).toBeVisible({ timeout: JOB_TIMEOUT });

    // ── Verify the execute task completed (not still "running") ───────────────
    const runSuiteTask = page.locator("div").filter({ hasText: /^Run suite/ }).first();
    await expect(runSuiteTask).not.toContainText("running");
  });

  test("job status reflects succeeded or failed — never stuck in queued", async ({ page }) => {
    test.setTimeout(JOB_TIMEOUT + 60_000);
    await page.goto("/qa-agent");

    await pickFromSelect(page, 0, PROJECT_HINT);
    await pickFromSelect(page, 1, SUITE_HINT);

    await page.getByRole("button", { name: /start qa agent/i }).click();
    await expect(page.getByText("Job status")).toBeVisible({ timeout: 15_000 });

    // Wait for terminal state
    const succeeded = page.getByText("succeeded");
    const failed    = page.getByText("failed");
    await expect(succeeded.or(failed).first()).toBeVisible({ timeout: JOB_TIMEOUT });

    // Button should no longer say "Running…"
    await expect(page.getByRole("button", { name: /running/i })).not.toBeVisible();
  });
});
