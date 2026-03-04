import { PrismaClient, Prisma } from "@prisma/client";

const prisma = new PrismaClient();

type Summary = {
  sourceUserId: string;
  movedProjects: number;
  movedAgentSessions: number;
  movedJiraIntegrations: number;
  movedTestCaseRuns: number;
  removedGitAccounts: number;
  removedSourceUser: boolean;
};

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (name: string) => {
    const idx = args.findIndex((a) => a === name);
    if (idx < 0) return "";
    return args[idx + 1] ?? "";
  };
  const target = get("--target");
  const sourcesRaw = get("--sources");
  const dryRunFlag = args.includes("--dry-run");
  const sources = sourcesRaw
    .split(/[,\s]+/)
    .map((v) => v.trim())
    .filter(Boolean);
  return { target, sources, dryRun: dryRunFlag };
}

async function ensureTargetUser(targetUserId: string, dryRun: boolean) {
  const existing = await prisma.user.findUnique({
    where: { id: targetUserId },
    select: { id: true, plan: true },
  });
  if (existing) return existing;
  if (dryRun) {
    return { id: targetUserId, plan: "free" as const };
  }
  return prisma.user.create({
    data: { id: targetUserId, plan: "free" },
    select: { id: true, plan: true },
  });
}

async function migrateSourceToTarget(
  sourceUserId: string,
  targetUserId: string,
  dryRun: boolean
): Promise<Summary> {
  const source = await prisma.user.findUnique({
    where: { id: sourceUserId },
    select: { id: true, plan: true },
  });
  if (!source) {
    return {
      sourceUserId,
      movedProjects: 0,
      movedAgentSessions: 0,
      movedJiraIntegrations: 0,
      movedTestCaseRuns: 0,
      removedGitAccounts: 0,
      removedSourceUser: false,
    };
  }

  const projects = await prisma.project.count({ where: { ownerId: sourceUserId } });
  const agentSessions = await prisma.agentSession.count({ where: { userId: sourceUserId } });
  const jiraIntegrations = await prisma.jiraIntegration.count({ where: { userId: sourceUserId } });
  const testCaseRuns = await prisma.testCaseRun.count({ where: { userId: sourceUserId } });
  const sourceGitAccounts = await prisma.gitAccount.count({ where: { userId: sourceUserId } });

  if (dryRun) {
    return {
      sourceUserId,
      movedProjects: projects,
      movedAgentSessions: agentSessions,
      movedJiraIntegrations: jiraIntegrations,
      movedTestCaseRuns: testCaseRuns,
      removedGitAccounts: sourceGitAccounts,
      removedSourceUser: false,
    };
  }

  await prisma.$transaction(async (tx) => {
    await tx.project.updateMany({
      where: { ownerId: sourceUserId },
      data: { ownerId: targetUserId },
    });
    await tx.agentSession.updateMany({
      where: { userId: sourceUserId },
      data: { userId: targetUserId },
    });
    await tx.testCaseRun.updateMany({
      where: { userId: sourceUserId },
      data: { userId: targetUserId },
    });

    const sourceJira = await tx.jiraIntegration.findMany({
      where: { userId: sourceUserId },
      select: { id: true, projectId: true },
    });
    for (const row of sourceJira) {
      const targetConflict = await tx.jiraIntegration.findFirst({
        where: { userId: targetUserId, projectId: row.projectId },
        select: { id: true },
      });
      if (targetConflict) {
        await tx.jiraIntegration.delete({ where: { id: row.id } });
        continue;
      }
      await tx.jiraIntegration.update({
        where: { id: row.id },
        data: { userId: targetUserId },
      });
    }

    const targetHasGit = await tx.gitAccount.findFirst({
      where: { provider: "github", userId: targetUserId },
      select: { id: true },
    });
    if (targetHasGit) {
      await tx.gitAccount.deleteMany({ where: { userId: sourceUserId } });
    } else {
      const sourceGit = await tx.gitAccount.findFirst({
        where: { provider: "github", userId: sourceUserId },
        select: { id: true },
      });
      if (sourceGit) {
        await tx.gitAccount.update({
          where: { id: sourceGit.id },
          data: { userId: targetUserId },
        });
      }
      await tx.gitAccount.deleteMany({ where: { userId: sourceUserId } });
    }

    const targetUser = await tx.user.findUnique({
      where: { id: targetUserId },
      select: { id: true, plan: true },
    });
    if (targetUser && !targetUser.plan && source.plan) {
      await tx.user.update({
        where: { id: targetUserId },
        data: { plan: source.plan },
      });
    }

    await tx.user.deleteMany({ where: { id: sourceUserId } });
  });

  return {
    sourceUserId,
    movedProjects: projects,
    movedAgentSessions: agentSessions,
    movedJiraIntegrations: jiraIntegrations,
    movedTestCaseRuns: testCaseRuns,
    removedGitAccounts: sourceGitAccounts,
    removedSourceUser: true,
  };
}

async function main() {
  const { target, sources, dryRun } = parseArgs();
  if (!target || sources.length === 0) {
    console.error(
      "Usage: pnpm --filter api exec tsx scripts/migrate-user-ownership.ts --target <user_id> --sources <id1,id2,...> [--dry-run]"
    );
    process.exit(1);
  }
  if (sources.includes(target)) {
    console.error("Target user ID must not be included in --sources.");
    process.exit(1);
  }

  await ensureTargetUser(target, dryRun);

  const summaries: Summary[] = [];
  for (const sourceUserId of sources) {
    const summary = await migrateSourceToTarget(sourceUserId, target, dryRun);
    summaries.push(summary);
  }

  const total = summaries.reduce(
    (acc, s) => ({
      movedProjects: acc.movedProjects + s.movedProjects,
      movedAgentSessions: acc.movedAgentSessions + s.movedAgentSessions,
      movedJiraIntegrations: acc.movedJiraIntegrations + s.movedJiraIntegrations,
      movedTestCaseRuns: acc.movedTestCaseRuns + s.movedTestCaseRuns,
      removedGitAccounts: acc.removedGitAccounts + s.removedGitAccounts,
      removedSourceUsers: acc.removedSourceUsers + (s.removedSourceUser ? 1 : 0),
    }),
    {
      movedProjects: 0,
      movedAgentSessions: 0,
      movedJiraIntegrations: 0,
      movedTestCaseRuns: 0,
      removedGitAccounts: 0,
      removedSourceUsers: 0,
    }
  );

  console.log(
    JSON.stringify(
      {
        mode: dryRun ? "dry-run" : "apply",
        targetUserId: target,
        sources,
        summaries,
        total,
      },
      null,
      2
    )
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
