// apps/api/src/lib/application-model-store.ts
//
// I/O wrapper around apps/api/src/lib/application-model.ts's pure store logic, following the
// same extraction pattern as lib/locator-promotion.ts: application-model.ts stays free of
// Prisma imports by design (its own header comment says so), and this sibling file is where
// I/O lives once there's more than one caller - Ticket AB.4 is about to make that true, adding
// three more concurrent writers to the one that exists today (operator-worker.ts).
//
// Concurrency: Project has no updatedAt column, so optimistic-concurrency control uses a
// dedicated applicationModelVersion counter instead (see prisma/schema.prisma's comment on
// it) - incremented only here, so a CAS conflict only ever means "another Brain write raced
// this one," never "someone renamed the project" or made an unrelated Project edit.
import { prisma } from "../prisma.js";
import { normalizeApplicationModel, type ApplicationModelStore } from "./application-model.js";

export const MAX_MERGE_RETRIES = 5;

export class MergeConflictError extends Error {
  constructor(projectId: string, attempts: number) {
    super(
      `Application Brain merge for project ${projectId} could not land after ${attempts} attempts (concurrent writes kept winning the race).`
    );
    this.name = "MergeConflictError";
  }
}

/**
 * Reads Project.applicationModel + applicationModelVersion, applies mergeFn to the current
 * store, and writes the result back guarded by a compare-and-swap on applicationModelVersion.
 *
 * On a CAS miss (another writer landed first), the NEXT loop iteration rereads the
 * now-current applicationModel/applicationModelVersion and reapplies mergeFn to that fresh
 * value - it never retries by writing the previously-computed (now stale) merge result, which
 * would silently discard the concurrent writer's change. This is the one place a subtle
 * implementation mistake could undermine the whole shared store; see application-model-
 * store.test.ts's dedicated test for the failure mode this rules out.
 *
 * Retries up to MAX_MERGE_RETRIES times before throwing MergeConflictError. Callers (Ticket
 * AB.4 producers) must catch this and continue their underlying feature unchanged - a Brain
 * merge that can't land must never fail (or even delay) the operation it's attached to.
 *
 * mergeFn may be sync or async (the pure functions in application-model.ts are all sync; async
 * support exists for callers/tests that need to await something as part of computing the
 * merge - see the "two concurrent merges must both land" test for why this matters for testing
 * the retry behavior deterministically without real threads).
 */
export async function applyApplicationModelMerge(
  projectId: string,
  mergeFn: (store: ApplicationModelStore) => ApplicationModelStore | Promise<ApplicationModelStore>
): Promise<ApplicationModelStore> {
  for (let attempt = 1; attempt <= MAX_MERGE_RETRIES; attempt += 1) {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { applicationModel: true, applicationModelVersion: true },
    });
    if (!project) throw new Error(`Project ${projectId} not found`);

    const current = normalizeApplicationModel(project.applicationModel);
    const next = await mergeFn(current);

    const result = await prisma.project.updateMany({
      where: { id: projectId, applicationModelVersion: project.applicationModelVersion },
      data: { applicationModel: next as any, applicationModelVersion: { increment: 1 } },
    });

    if (result.count > 0) return next;
    // CAS miss: fall through to the next loop iteration, which rereads the now-current value
    // and reapplies mergeFn to it - not to `next`, which is now stale.
  }
  throw new MergeConflictError(projectId, MAX_MERGE_RETRIES);
}
