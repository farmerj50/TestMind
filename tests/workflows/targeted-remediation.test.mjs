import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createOperatorHarness, loadTs } from './operator-harness.mjs';
import { artifactModules } from './artifact-harness.mjs';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../apps/api/package.json', import.meta.url));

test('legacy report view keeps ownership checks and blocks free-form HTML', async () => {
  const prisma = { testRun: { findUnique: async () => ({ id: 'run', projectId: 'project', project: { ownerId: 'owner' } }) } };
  const { routes } = artifactModules(prisma, process.cwd(), {});
  const app = require('fastify')(); await app.register(routes.artifactRoutes);
  try {
    assert.equal((await app.inject({ url: '/runner/test-runs/run/view' })).statusCode, 401);
    assert.equal((await app.inject({ url: '/runner/test-runs/run/view', headers: { 'x-user-id': 'foreign' } })).statusCode, 404);
    const response = await app.inject({ url: '/runner/test-runs/run/view', headers: { 'x-user-id': 'owner' } });
    assert.equal(response.statusCode, 422);
    assert.equal(response.json().error, 'ARTIFACT_SECURITY_BLOCKED');
  } finally { await app.close(); }
});

test('No tests found is a runner/infrastructure failure, never an application defect', async () => {
  const h = createOperatorHarness(); await h.tick();
  h.finishRun('failed', [{ status: 'failed', message: 'Error: No tests found.' }]);
  await assert.rejects(h.tick());
  assert.equal(h.tables.humanInterventionCandidate[0].contextJson.type, 'blocked');
  assert.equal(h.calls.heals.length, 0);
});
for (const state of ['approved', 'denied', 'expired', 'canceled', 'foreign-owner', 'changed-source']) test(`repair proposal gate handles ${state} without premature writes`, async () => {
  const original = 'original fixture', patched = 'patched fixture'; let checks = 0;
  const task = { id: 'task', jobId: 'job', job: { contextJson: { repairApprovalRequired: true }, project: { ownerId: 'owner' } } };
  const record = { requestedBy: 'owner', contextJson: { originalDigest: crypto.createHash('sha256').update(original).digest('hex'), proposedDigest: crypto.createHash('sha256').update(patched).digest('hex') } };
  const prisma = { operatorTask: { findFirst: async () => task }, testHealingAttempt: { update: async () => {} }, operatorApproval: {
    upsert: async () => record, updateMany: async () => ({ count: 1 }), findUniqueOrThrow: async () => ({ ...record, status: ['denied', 'expired'].includes(state) ? state : 'approved', resolvedBy: state === 'foreign-owner' ? 'other' : 'owner', expiresAt: new Date(Date.now() + 10000), job: { status: state === 'canceled' ? 'canceled' : 'running', project: { ownerId: 'owner' } } }),
  } };
  const module = loadTs('apps/api/src/ai/core/repair-approval.ts', { 'node:crypto': crypto, 'node:fs/promises': { readFile: async () => state === 'changed-source' ? 'changed' : original }, '../../prisma.js': { prisma }, '../../lib/workflow-execution-policy.js': { authorizeWorkflowRepair: async () => checks++ } });
  const operation = module.approveRepairProposal('attempt', { scope: { projectId: 'project' }, job: { runId: 'run' }, specContent: original, repoAbsolutePath: 'fixture.spec.ts' }, patched);
  if (state === 'approved') await operation; else await assert.rejects(operation);
  assert.ok(checks > 0);
});
