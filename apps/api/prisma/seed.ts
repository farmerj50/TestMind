import { PrismaClient, PlanTier } from '@prisma/client';

/**
 * Seeds a placeholder user and projects so the existing spec files can be reused
 * without recreating everything manually in the UI. The user id can be swapped
 * later to your real Clerk id by updating User.id and Project.ownerId.
 */
const prisma = new PrismaClient();

const ownerId = 'user_johnfarmer_local';
const ownerEmail = 'johnfarmer43@gmail.com';

const projects: Array<{ id: string; name: string; repoUrl: string }> = [
  { id: 'proj_generated_playwright', name: 'Generated (playwright-ts)', repoUrl: 'local://playwright-ts' },
  { id: 'proj_generated_cucumber', name: 'Generated (cucumber-js)', repoUrl: 'local://cucumber-js' },
  { id: 'proj_generated_cypress', name: 'Generated (cypress-js)', repoUrl: 'local://cypress-js' },
  { id: 'proj_generated_appium', name: 'Generated (appium-js)', repoUrl: 'local://appium-js' },
  { id: 'proj_generated_xctest', name: 'Generated (xctest)', repoUrl: 'local://xctest' },
  { id: 'proj_custom_curated', name: 'My Custom Suite (curated)', repoUrl: 'local://custom' },
  // Preserve the previously used project id so existing UI state can find it
  {
    id: 'cmi7sp4hs00017kmkve5law3',
    name: 'testMind (curated)',
    repoUrl: 'local://testMind',
  },
  { id: 'proj_regression_curated', name: 'regression (curated)', repoUrl: 'local://regression' },
  { id: 'proj_justicepath_curated', name: 'justicepath (curated)', repoUrl: 'local://justicepath' },
  { id: 'proj_agent_testmind_curated', name: 'Agent - testmind (curated)', repoUrl: 'local://agent-testmind' },
];

async function main() {
  // Create placeholder user (id can be replaced later with real Clerk id)
  await prisma.user.upsert({
    where: { id: ownerId },
    update: { plan: PlanTier.free },
    create: {
      id: ownerId,
      plan: PlanTier.free,
    },
  });

  // Create projects tied to the placeholder user
  for (const proj of projects) {
    const where = { id: proj.id };
    await prisma.project.upsert({
      where,
      update: {
        name: proj.name,
        repoUrl: proj.repoUrl,
        ownerId,
        plan: PlanTier.free,
      },
      create: {
        id: proj.id,
        name: proj.name,
        repoUrl: proj.repoUrl,
        ownerId,
        plan: PlanTier.free,
      },
    });
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
