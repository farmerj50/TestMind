import { repositoryEvidence } from "./repository-evidence.js";
// B2: I/O around lib/app-knowledge.ts. Reads the existing Application Brain snapshot
// (coverage, execution history, defects), API Testing inventory, and repository sources;
// writes through applyApplicationModelMerge (CAS) so concurrent writers never clobber facts.
import fs from "node:fs/promises";
import path from "node:path";
import { prisma } from "../prisma.js";
import { getApplicationBrainSnapshot } from "./application-brain-query.js";
import { applyApplicationModelMerge } from "./application-model-store.js";
import { normalizeApplicationModel, type ApplicationModelStore, type DeclaredRoutes } from "./application-model.js";
import {
  attributeRoute,
  routeClaimsFromTitles,
  buildStoryRecord,
  extractDeclaredRoutes,
  recommendNextTests,
  summarizeCoverage,
  upsertStory,
  type KnowledgeInputs,
  type Recommendation,
  type CoverageSummary,
} from "./app-knowledge.js";

export async function loadKnowledgeInputs(projectId: string): Promise<KnowledgeInputs> {
  const snapshot = await getApplicationBrainSnapshot(projectId);
  const apiCases = await prisma.apiTestCase.findMany({ where: { collection: { projectId } }, select: { path: true }, take: 5000 });
  const qaFailures = snapshot.qaFailures.map((f) => ({ testCaseId: f.testCaseId, routeHint: f.routeHint, lastResultStatus: f.lastResultStatus, lastFailureMessage: f.lastFailureMessage, lastRunAt: f.lastRunAt }));

  // Execution history the route-indexed snapshot can't attribute (e.g. generated-suite cases
  // keyed by spec file). Attributed to a route ONLY when the test's title/key names a page the
  // Brain has observed; otherwise kept as unattributed history - never guessed.
  const known = new Set(qaFailures.map((f) => f.testCaseId));
  const failing = await prisma.testCase.findMany({
    where: { projectId, status: { not: "archived" }, lastResultStatus: { in: ["failed", "error"] }, id: { notIn: [...known] } },
    select: { id: true, title: true, key: true, lastResultStatus: true },
    take: 200,
  });
  const routes = Object.keys(snapshot.store.pages);
  for (const tc of failing) {
    const last = await prisma.testResult.findFirst({ where: { testCaseId: tc.id, status: { in: ["failed", "error"] } }, orderBy: { createdAt: "desc" }, select: { message: true, createdAt: true } });
    qaFailures.push({
      testCaseId: tc.id,
      routeHint: attributeRoute(`${tc.title} ${tc.key}`, routes) ?? "(unattributed)",
      lastResultStatus: tc.lastResultStatus ?? "failed",
      lastFailureMessage: last?.message ? last.message.slice(0, 1000) : null,
      lastRunAt: last?.createdAt.toISOString() ?? null,
    });
  }

  const failingIds = qaFailures.map((f) => f.testCaseId);
  const titles = failingIds.length
    ? await prisma.testCase.findMany({ where: { id: { in: failingIds } }, select: { id: true, title: true } })
    : [];
  const allTitles = await prisma.testCase.findMany({ where: { projectId, status: { not: "archived" } }, select: { title: true }, take: 500 });
  return {
    testRouteClaims: routeClaimsFromTitles(allTitles.map((t) => t.title)),
    store: snapshot.store,
    coverage: snapshot.coverage.map((c) => ({ routeHint: c.routeHint, testCaseId: c.testCaseId, lastResultStatus: c.lastResultStatus, lastRunAt: c.lastRunAt })),
    qaFailures,
    apiTestPaths: apiCases.map((c) => c.path),
    testTitles: titles,
  };
}

export type ProjectKnowledge = {
  summary: CoverageSummary;
  recommendations: Recommendation[];
  pages: ApplicationModelStore["pages"];
  apis: ApplicationModelStore["apis"];
  stories: NonNullable<ApplicationModelStore["stories"]>;
  declared: ApplicationModelStore["declared"] | null;
  testInventory: { testCases: number; linkedToRoutes: number; apiTestCases: number };
};

export async function getProjectKnowledge(projectId: string, opts: { limit?: number } = {}): Promise<ProjectKnowledge> {
  const inputs = await loadKnowledgeInputs(projectId);
  const testCases = await prisma.testCase.count({ where: { projectId, status: { not: "archived" } } });
  return {
    summary: summarizeCoverage(inputs),
    recommendations: recommendNextTests(inputs, { limit: opts.limit ?? 50 }),
    pages: inputs.store.pages,
    apis: inputs.store.apis,
    stories: inputs.store.stories ?? {},
    declared: inputs.store.declared ?? null,
    testInventory: { testCases, linkedToRoutes: new Set(inputs.coverage.map((c) => c.testCaseId)).size, apiTestCases: inputs.apiTestPaths.length },
  };
}

/** Records a user story (expected behavior) and maps its criteria to observed evidence. */
export async function recordUserStory(projectId: string, text: string, runId?: string) {
  const now = new Date().toISOString();
  let recorded: ReturnType<typeof buildStoryRecord> | null = null;
  await applyApplicationModelMerge(projectId, (store) => {
    const key = buildStoryRecord(text, store, now).key;
    recorded = buildStoryRecord(text, store, now, runId, store.stories?.[key]);
    return upsertStory(store, recorded);
  });
  return recorded!;
}

// ── Repository inspection ────────────────────────────────────────────────────

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "coverage", "test-results", "playwright-report", "allure-results", ".turbo", ".cache"]);
const SOURCE_RE = /\.(tsx?|jsx?|mjs|cjs)$/;
const TEST_RE = /\.(spec|test)\.[cm]?[jt]sx?$/;
const MAX_FILES = 3000;
const MAX_FILE_BYTES = 256 * 1024;

/** Bounded, read-only walk of a repository: declared UI/API routes + existing test files. */
export async function inspectRepository(root: string, label: string): Promise<DeclaredRoutes> {
  const sources: Array<{ file: string; content: string }> = [];
  const testFiles: string[] = [];
  let visited = 0;
  let truncated = false;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: import("node:fs").Dirent[];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.name.startsWith(".") && e.name !== ".github") continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && !/^testmind-/.test(e.name)) stack.push(abs); continue; }
      if (!e.isFile() || !SOURCE_RE.test(e.name)) continue;
      if (++visited > MAX_FILES) { truncated = true; stack.length = 0; break; }
      const rel = path.relative(root, abs).replace(/\\/g, "/");
      if (TEST_RE.test(e.name)) { testFiles.push(rel); continue; }
      try {
        const st = await fs.stat(abs);
        if (st.size > MAX_FILE_BYTES) continue;
        sources.push({ file: rel, content: await fs.readFile(abs, "utf8") });
      } catch { /* unreadable - skip */ }
    }
  }
  const { uiRoutes, apiRoutes } = extractDeclaredRoutes(sources);
  return { repo: label, inspectedAt: new Date().toISOString(), source: "repository", evidence: repositoryEvidence(root, [...uiRoutes.map((r) => r.path), ...apiRoutes.map((r) => r.path)].join(" ")), uiRoutes, apiRoutes, testFiles: testFiles.sort().slice(0, 2000), truncated };
}

export function resolveLocalRepository(targetRepo: string): string | null {
  if (targetRepo !== "testmind") return null;
  return process.env.TM_LOCAL_REPO_ROOT?.trim() ? path.resolve(process.env.TM_LOCAL_REPO_ROOT) : path.resolve(process.cwd(), "..", "..");
}

export async function recordDeclaredRoutes(projectId: string, declared: DeclaredRoutes) {
  await applyApplicationModelMerge(projectId, (store) => ({ ...normalizeApplicationModel(store), declared }));
}

/** B3: everything the planner needs, from the Brain + existing inventory (bounded). */
export async function loadPlanInputs(projectId: string) {
  const k = await loadKnowledgeInputs(projectId);
  const titleById = new Map((k.testTitles ?? []).map((t) => [t.id, t.title]));
  const existingTests = await prisma.testCase.findMany({ where: { projectId, status: { not: "archived" } }, select: { title: true }, take: 2000 });
  return {
    store: k.store,
    coverageRoutes: [...new Set(k.coverage.map((c) => c.routeHint))],
    failing: k.qaFailures.filter((f) => f.routeHint.startsWith("/")).map((f) => ({ route: f.routeHint, title: titleById.get(f.testCaseId) ?? f.testCaseId, lastFailureMessage: f.lastFailureMessage, lastRunAt: f.lastRunAt })),
    existingTests,
    apiTestPaths: k.apiTestPaths,
  };
}

/** B3: the persisted plan objective for a test title in the most recent QE plan of a project (for generation/repair). */
export async function findPlannedObjective(projectId: string, testTitle: string) {
  const plans = await prisma.operatorArtifact.findMany({
    where: { type: "plan", job: { projectId }, metaJson: { path: ["qePlan", "version"], equals: 1 } },
    orderBy: { createdAt: "desc" }, take: 10, select: { jobId: true, metaJson: true },
  });
  for (const p of plans) {
    const scenario = ((p.metaJson as any).qePlan?.scenarios ?? []).find((s: any) => s.execution?.testTitle === testTitle);
    if (scenario) return { jobId: p.jobId, scenario };
  }
  return null;
}

/** B5: persist investigations (and suspected defects) to the Brain with CAS merge. */
export async function recordFailureInvestigations(projectId: string, invs: import("./failure-intel.js").FailureInvestigation[], runId: string) {
  const { recordInvestigationsInStore } = await import("./failure-intel.js");
  const at = new Date().toISOString();
  await applyApplicationModelMerge(projectId, (store) => recordInvestigationsInStore(store, invs, runId, at));
}

/** B5: attach the final repair outcome for a test to its Brain investigation. */
export async function recordRepairOutcome(projectId: string, testCaseId: string, status: "repaired_verified" | "repair_failed" | "repair_rejected" | "escalated" | "held", detail: string) {
  const { recordRepairOutcomeInStore } = await import("./failure-intel.js");
  await applyApplicationModelMerge(projectId, (store) => recordRepairOutcomeInStore(store, testCaseId, { status, detail: detail.slice(0, 500), at: new Date().toISOString() }));
}
