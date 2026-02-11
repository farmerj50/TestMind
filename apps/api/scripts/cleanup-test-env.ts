import path from "node:path";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import { prisma } from "../src/prisma.js";

const REPO_ROOT = path.resolve(process.cwd(), "..", "..");

const cleanupDirs = [
  path.join(REPO_ROOT, "testmind-generated"),
  path.join(REPO_ROOT, "testmind-curated"),
  path.join(REPO_ROOT, "testmind-reports"),
  path.join(REPO_ROOT, "test-results"),
  path.join(REPO_ROOT, "playwright-report"),
  path.join(REPO_ROOT, "runner-logs"),
  path.join(REPO_ROOT, "apps", "web", "testmind-generated"),
  path.join(REPO_ROOT, "apps", "api", "testmind-generated"),
  path.join(REPO_ROOT, "apps", "api", "runner-logs"),
];

async function cleanFilesystem() {
  for (const dir of cleanupDirs) {
    if (!fsSync.existsSync(dir)) continue;
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function cleanDatabase() {
  // Delete child tables before parents to satisfy FKs.
  await prisma.$transaction(async (tx) => {
    await tx.testHealingAttempt.deleteMany();
    await tx.testResult.deleteMany();
    await tx.testCaseRun.deleteMany();
    await tx.testStep.deleteMany();
    await tx.testCase.deleteMany();
    await tx.testSuite.deleteMany();
    await tx.testRun.deleteMany();

    await tx.agentScenario.deleteMany();
    await tx.agentPage.deleteMany();
    await tx.agentSession.deleteMany();

    await tx.securityFinding.deleteMany();
    await tx.securityScanJob.deleteMany();

    await tx.jiraRequirement.deleteMany();
    await tx.jiraIntegration.deleteMany();
    await tx.integration.deleteMany();
    await tx.projectSecret.deleteMany();
    await tx.curatedSuite.deleteMany();

    await tx.project.deleteMany();
    await tx.user.deleteMany();
  });
}

async function main() {
  console.log("[cleanup] starting");
  await cleanDatabase();
  await cleanFilesystem();
  console.log("[cleanup] done");
}

main()
  .catch((err) => {
    console.error("[cleanup] failed", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => {});
  });
