import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import * as core from '../../packages/testmind-core/workflow/index.js';
import { loadTs } from './operator-harness.mjs';
const require = createRequire(new URL('../../apps/api/package.json', import.meta.url));
const intent = loadTs('apps/api/src/ai/core/repair-policy.ts', { diff: require('diff'), typescript: require('typescript'), '@testmind/core/framework': { DEFAULT_FRAMEWORK_ID: 'playwright-ts' } });
const before = "test('checkout', async ({page}) => { await expect(page.locator('#old')).toBeVisible(); });";
function actions(authorize, patchedSpec = before.replace('#old', '#new')) {
  let attempts = 0;
  const action = loadTs('apps/api/src/ai/core/action-service.ts', {
    './context.js': { buildAiExecutionContext: async () => ({ specContent: before }) }, './policy.js': { readSelfHealPolicy: () => ({ repair: {}, liveProbe: {} }) },
    './repair-executor.js': { executeRepairAttempt: async () => { attempts++; return { kind: 'rule', patchedSpec }; } },
    './repair-policy.js': intent, '../../lib/workflow-execution-policy.js': { authorizeWorkflowRepair: authorize },
  });
  return { run: () => action.executeAutonomousRepairAction({ job: { runId: 'child', projectId: 'project' } }), get attempts() { return attempts; } };
}
test('queued autonomous repair checks current authorization before executing', async () => {
  const h = actions(async () => { throw new Error('Workflow execution is no longer authorized'); });
  await assert.rejects(h.run(), /no longer authorized/); assert.equal(h.attempts, 0);
});
test('repair rechecks cancellation/approval before returning a patch for persistence', async () => {
  let checks = 0; const h = actions(async () => { if (++checks === 2) throw new Error('Workflow canceled'); });
  await assert.rejects(h.run(), /canceled/); assert.equal(checks, 2);
});
test('deterministic repair cannot bypass assertion preservation', async () => {
  const h = actions(async () => {}, "test('checkout', async ({page}) => {});");
  await assert.rejects(h.run(), /required assertions/);
});
test('authorized locator-only repair retains its assertion and remains available', async () => {
  const h = actions(async () => {}); const result = await h.run();
  assert.ok(result.repairResult.patchedSpec.includes('#new')); assert.ok(result.repairResult.patchedSpec.includes('toBeVisible'));
});
for (const autonomy of ['assisted', 'autonomous-testing']) test(`${autonomy} cannot execute queued repairs through the shared repair action`, async () => {
  const policy = loadTs('apps/api/src/lib/workflow-execution-policy.ts', {
    '@testmind/core/workflow': core, './workflow-version.js': { environmentFingerprint: () => 'env' },
    '../prisma.js': { prisma: { testRun: { findFirst: async () => ({ paramsJson: { workflowParentId: 'parent' } }) }, workflowRun: { findUnique: async () => ({ status: 'running', requestedBy: 'owner', createdAt: new Date(), workflow: { projectId: 'project', project: { ownerId: 'owner' } }, version: { snapshotJson: { configJson: { graph: { autonomy, limits: { maxDurationMs: 60000 } } } } }, contextJson: { environmentFingerprint: 'env' } }) } } },
  });
  await assert.rejects(policy.authorizeWorkflowRepair('child', 'project'), /autonomy level/);
});

test('repair mirroring writes only registered project suites and rejects symlink escapes', async () => {
  const generated = path.resolve('virtual-generated'), curated = path.resolve('virtual-curated');
  const writes = [], queries = [];
  const repoAbsolutePath = path.join(generated, 'playwright-owner', 'owned-project', 'home.spec.ts');
  const service = loadTs('apps/api/src/ai/core/repair-service.ts', { './repair-approval.js': { approveRepairProposal: async () => {} },
    'fs/promises': { mkdir: async () => {}, writeFile: async file => writes.push(file), realpath: async file => file.includes(`${path.sep}escape${path.sep}`) ? path.join(curated, 'foreign', 'home.spec.ts') : file },
    diff: require('diff'), '../../prisma.js': { prisma: { curatedSuite: { findMany: async query => { queries.push(query); return [{ rootRel: 'owned' }, { rootRel: 'escape' }]; } }, testHealingAttempt: { update: async () => {} } } },
    '../../lib/storageRoots.js': { GENERATED_ROOT: generated, CURATED_ROOT: curated }, './repair-policy.js': intent,
    '../../lib/workflow-execution-policy.js': { authorizeWorkflowRepair: async () => {} },
  });
  await service.recordRuleRepairSuccess({ attemptId: 'attempt', context: { job: { runId: 'run' }, scope: { projectId: 'owned-project' }, repoAbsolutePath, repoRelativePath: 'home.spec.ts', specContent: before }, patchedSpec: before.replace('#old', '#new'), summary: 'Locator repair', note: 'audit' });
  assert.equal(queries[0].where.projectId, 'owned-project');
  assert.deepEqual(writes, [repoAbsolutePath, path.join(curated, 'owned', 'home.spec.ts')]);
});

test('repair persistence rechecks authorization before any filesystem mutation', async () => {
  let writes = 0;
  const service = loadTs('apps/api/src/ai/core/repair-service.ts', { './repair-approval.js': { approveRepairProposal: async () => {} },
    'fs/promises': { mkdir: async () => writes++, writeFile: async () => writes++ }, diff: require('diff'), '../../prisma.js': {}, '../../lib/storageRoots.js': {},
    './repair-policy.js': intent, '../../lib/workflow-execution-policy.js': { authorizeWorkflowRepair: async () => { throw new Error('Approval revoked'); } },
  });
  await assert.rejects(service.recordRuleRepairSuccess({ context: { job: { runId: 'run' }, scope: { projectId: 'project' }, specContent: before }, patchedSpec: before }), /Approval revoked/);
  assert.equal(writes, 0);
});
