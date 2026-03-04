import { PrismaClient, PlanTier } from "@prisma/client";

const prisma = new PrismaClient();

type Mapping = { from: string; to: string };

type Counts = {
  projects: number;
  agentSessions: number;
  jiraIntegrations: number;
  testCaseRuns: number;
  gitAccounts: number;
};

type MappingSummary = {
  from: string;
  to: string;
  before: Counts;
  moved: Counts;
  jiraMergedIntoExisting: number;
  gitMergedIntoExisting: number;
  planCopied: boolean;
  sourceUserDeleted: boolean;
};

const EMPTY_COUNTS: Counts = {
  projects: 0,
  agentSessions: 0,
  jiraIntegrations: 0,
  testCaseRuns: 0,
  gitAccounts: 0,
};

function parseArgs() {
  const args = process.argv.slice(2);
  const has = (flag: string) => args.includes(flag);
  const get = (name: string) => {
    const idx = args.findIndex((a) => a === name);
    if (idx < 0) return "";
    return args[idx + 1] ?? "";
  };

  const from = get("--from").trim();
  const to = get("--to").trim();
  const mapRaw = get("--map").trim();
  const apply = has("--apply");
  const deleteSources = has("--delete-sources");

  const pairs: Mapping[] = [];
  if (mapRaw) {
    for (const token of mapRaw.split(/[,\s]+/).map((v) => v.trim()).filter(Boolean)) {
      const [left, right] = token.split(":").map((v) => v?.trim() ?? "");
      if (!left || !right) {
        throw new Error(`Invalid --map entry: "${token}". Use oldUserId:newUserId.`);
      }
      pairs.push({ from: left, to: right });
    }
  }
  if (from || to) {
    if (!from || !to) {
      throw new Error("When using --from/--to, both values are required.");
    }
    pairs.push({ from, to });
  }
  if (!pairs.length) {
    throw new Error(
      "Provide either --from <oldUserId> --to <newUserId> or --map old1:new1,old2:new2."
    );
  }

  // Deduplicate exact pairs.
  const uniq = new Map<string, Mapping>();
  for (const p of pairs) {
    if (p.from === p.to) {
      throw new Error(`Invalid mapping "${p.from}:${p.to}" (source and target are identical).`);
    }
    uniq.set(`${p.from}->${p.to}`, p);
  }

  // Ensure a source isn't mapped to multiple targets in same run.
  const sourceTargets = new Map<string, string>();
  for (const p of uniq.values()) {
    const existing = sourceTargets.get(p.from);
    if (existing && existing !== p.to) {
      throw new Error(
        `Source "${p.from}" is mapped to multiple targets (${existing}, ${p.to}) in one run.`
      );
    }
    sourceTargets.set(p.from, p.to);
  }

  return {
    mappings: Array.from(uniq.values()),
    apply,
    deleteSources,
  };
}

async function ensureUser(userId: string, apply: boolean) {
  const existing = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, plan: true },
  });
  if (existing) return existing;
  if (!apply) {
    return { id: userId, plan: null as PlanTier | null };
  }
  return prisma.user.create({
    data: { id: userId, plan: "free" },
    select: { id: true, plan: true },
  });
}

async function countsForUser(userId: string): Promise<Counts> {
  const [projects, agentSessions, jiraIntegrations, testCaseRuns, gitAccounts] = await Promise.all([
    prisma.project.count({ where: { ownerId: userId } }),
    prisma.agentSession.count({ where: { userId } }),
    prisma.jiraIntegration.count({ where: { userId } }),
    prisma.testCaseRun.count({ where: { userId } }),
    prisma.gitAccount.count({ where: { userId } }),
  ]);
  return { projects, agentSessions, jiraIntegrations, testCaseRuns, gitAccounts };
}

async function migrateOne(
  mapping: Mapping,
  apply: boolean,
  deleteSources: boolean
): Promise<MappingSummary> {
  const source = await prisma.user.findUnique({
    where: { id: mapping.from },
    select: { id: true, plan: true },
  });
  await ensureUser(mapping.to, apply);

  const before = await countsForUser(mapping.from);
  if (!source) {
    return {
      from: mapping.from,
      to: mapping.to,
      before: EMPTY_COUNTS,
      moved: EMPTY_COUNTS,
      jiraMergedIntoExisting: 0,
      gitMergedIntoExisting: 0,
      planCopied: false,
      sourceUserDeleted: false,
    };
  }

  if (!apply) {
    return {
      from: mapping.from,
      to: mapping.to,
      before,
      moved: before,
      jiraMergedIntoExisting: 0,
      gitMergedIntoExisting: 0,
      planCopied: false,
      sourceUserDeleted: false,
    };
  }

  let jiraMergedIntoExisting = 0;
  let gitMergedIntoExisting = 0;
  let planCopied = false;
  let sourceUserDeleted = false;

  await prisma.$transaction(async (tx) => {
    await tx.project.updateMany({
      where: { ownerId: mapping.from },
      data: { ownerId: mapping.to },
    });

    await tx.agentSession.updateMany({
      where: { userId: mapping.from },
      data: { userId: mapping.to },
    });

    await tx.testCaseRun.updateMany({
      where: { userId: mapping.from },
      data: { userId: mapping.to },
    });

    const sourceJira = await tx.jiraIntegration.findMany({
      where: { userId: mapping.from },
      select: { id: true, projectId: true },
    });
    for (const row of sourceJira) {
      const conflict = await tx.jiraIntegration.findFirst({
        where: { userId: mapping.to, projectId: row.projectId },
        select: { id: true },
      });
      if (conflict) {
        jiraMergedIntoExisting += 1;
        await tx.jiraIntegration.delete({ where: { id: row.id } });
      } else {
        await tx.jiraIntegration.update({
          where: { id: row.id },
          data: { userId: mapping.to },
        });
      }
    }

    const sourceGit = await tx.gitAccount.findMany({
      where: { userId: mapping.from },
      select: { id: true, provider: true },
    });
    for (const row of sourceGit) {
      const conflict = await tx.gitAccount.findFirst({
        where: { provider: row.provider, userId: mapping.to },
        select: { id: true },
      });
      if (conflict) {
        gitMergedIntoExisting += 1;
        await tx.gitAccount.delete({ where: { id: row.id } });
      } else {
        await tx.gitAccount.update({
          where: { id: row.id },
          data: { userId: mapping.to },
        });
      }
    }

    const targetUser = await tx.user.findUnique({
      where: { id: mapping.to },
      select: { id: true, plan: true },
    });
    if (targetUser && !targetUser.plan && source.plan) {
      await tx.user.update({
        where: { id: mapping.to },
        data: { plan: source.plan },
      });
      planCopied = true;
    }

    if (deleteSources) {
      const remaining = await Promise.all([
        tx.project.count({ where: { ownerId: mapping.from } }),
        tx.agentSession.count({ where: { userId: mapping.from } }),
        tx.jiraIntegration.count({ where: { userId: mapping.from } }),
        tx.testCaseRun.count({ where: { userId: mapping.from } }),
        tx.gitAccount.count({ where: { userId: mapping.from } }),
      ]);
      const hasRemaining = remaining.some((n) => n > 0);
      if (!hasRemaining) {
        await tx.user.deleteMany({ where: { id: mapping.from } });
        sourceUserDeleted = true;
      }
    }
  });

  return {
    from: mapping.from,
    to: mapping.to,
    before,
    moved: before,
    jiraMergedIntoExisting,
    gitMergedIntoExisting,
    planCopied,
    sourceUserDeleted,
  };
}

async function main() {
  const { mappings, apply, deleteSources } = parseArgs();

  const summaries: MappingSummary[] = [];
  for (const mapping of mappings) {
    const summary = await migrateOne(mapping, apply, deleteSources);
    summaries.push(summary);
  }

  const totals = summaries.reduce(
    (acc, s) => ({
      projects: acc.projects + s.moved.projects,
      agentSessions: acc.agentSessions + s.moved.agentSessions,
      jiraIntegrations: acc.jiraIntegrations + s.moved.jiraIntegrations,
      testCaseRuns: acc.testCaseRuns + s.moved.testCaseRuns,
      gitAccounts: acc.gitAccounts + s.moved.gitAccounts,
      jiraMergedIntoExisting: acc.jiraMergedIntoExisting + s.jiraMergedIntoExisting,
      gitMergedIntoExisting: acc.gitMergedIntoExisting + s.gitMergedIntoExisting,
      sourceUsersDeleted: acc.sourceUsersDeleted + (s.sourceUserDeleted ? 1 : 0),
    }),
    {
      projects: 0,
      agentSessions: 0,
      jiraIntegrations: 0,
      testCaseRuns: 0,
      gitAccounts: 0,
      jiraMergedIntoExisting: 0,
      gitMergedIntoExisting: 0,
      sourceUsersDeleted: 0,
    }
  );

  console.log(
    JSON.stringify(
      {
        mode: apply ? "apply" : "dry-run",
        deleteSources,
        mappings,
        summaries,
        totals,
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
