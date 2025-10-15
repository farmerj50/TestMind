// apps/api/src/testmind/pipeline/codegen.ts
import fs from "fs/promises";
import path from "path";
import type { TestPlan, TestCase } from "../core/plan.js";

const outRoot = path.resolve(process.cwd(), "apps/api/testmind-generated/playwright-ts/tests");

const slug = (s: string) =>
  String(s).replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase();

const pageKey = (tc: TestCase): string => {
  if (tc.group?.page) return tc.group.page;
  const firstGoto = tc.steps.find((s: any) => s.kind === "goto") as any;
  if (firstGoto?.url) {
    try { return new URL(firstGoto.url).pathname || "/"; } catch {}
  }
  return "misc";
};

function toPlaywright(tc: TestCase): string {
  const lines: string[] = [];
  lines.push(`import { test, expect } from '@playwright/test';`); // ensure import present per file
  lines.push(``);
  lines.push(`test(${JSON.stringify(tc.title)}, async ({ page }) => {`);
  for (const step of tc.steps) {
    if (step.kind === "goto") {
      lines.push(`  await page.goto(${JSON.stringify(step.url)});`);
    } else if (step.kind === "click") {
      if (step.by === "text") lines.push(`  await page.getByText(${JSON.stringify(step.value)}).click();`);
      else if (step.by === "role") lines.push(`  await page.getByRole(${JSON.stringify(step.value)}).click();`);
      else lines.push(`  await page.locator(${JSON.stringify(step.value)}).click();`);
    } else if (step.kind === "fill") {
      if (step.by === "label") lines.push(`  await page.getByLabel(${JSON.stringify(step.value)}).fill(${JSON.stringify(step.text)});`);
      else lines.push(`  await page.locator(${JSON.stringify(step.value)}).fill(${JSON.stringify(step.text)});`);
    } else if (step.kind === "expectVisible") {
      if (step.by === "text") lines.push(`  await expect(page.getByText(${JSON.stringify(step.value)})).toBeVisible();`);
      else lines.push(`  await expect(page.locator(${JSON.stringify(step.value)})).toBeVisible();`);
    }
  }
  lines.push(`});`);
  return lines.join("\n");
}

export async function writePlaywrightSpecs(plan: TestPlan) {
  // nuke old files (gets rid of route_*.spec.ts from previous writer)
  await fs.rm(outRoot, { recursive: true, force: true });
  await fs.mkdir(outRoot, { recursive: true });

  const byPage = new Map<string, TestCase[]>();
  for (const tc of (plan.cases ?? [])) {           // <-- uses .cases
    const key = pageKey(tc);
    if (!byPage.has(key)) byPage.set(key, []);
    byPage.get(key)!.push(tc);
  }

  for (const [page, list] of byPage) {
    const fname = `${slug(page || "root")}.spec.ts`;
    const body = list.map(toPlaywright).join("\n\n");
    await fs.writeFile(path.join(outRoot, fname), body, "utf-8");
  }
}
