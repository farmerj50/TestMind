import type { FastifyInstance } from 'fastify';
import path from 'node:path';
import { requireRunOwner } from '../lib/run-access.js';
import { REPORT_ROOT } from '../lib/storageRoots.js';
import { sendRunArtifact, artifactSecurityResponse } from '../lib/artifact-service.js';

// A debug token does not establish project ownership or a project secret scope.
// Keep authorization, but never return unscoped source or artifact contents.
export function registerDebugArtifactRead(app: FastifyInstance, options: {
  authorize: (req: any, reply: any) => boolean;
  resolvePath: (value: string | undefined) => { ok: boolean; base?: string; abs?: string };
  evidenceRoots: string[];
}) {
  app.get('/debug/volume/read', async (req: any, reply) => {
    if (!options.authorize(req, reply)) return;
    const resolved = options.resolvePath(req.query?.path);
    if (!resolved.ok || !resolved.base || !resolved.abs) return reply.code(400).send({ error: 'Bad path' });
    return artifactSecurityResponse(reply);
  });
}

export async function artifactRoutes(app: FastifyInstance, options: { roots?: string[] } = {}) {
  const roots = options.roots ?? [path.join(REPORT_ROOT, 'runner-logs'), path.resolve('runner-logs'), path.resolve('apps/api/runner-logs')];
  const handler = async (req: any, reply: any) => {
    const parts = String(req.params['*'] || '').split('/'); const runId = parts.shift();
    if (!runId) return reply.code(404).send({ error: 'Artifact not found' });
    const owner = await requireRunOwner(req, reply, runId); if (!owner) return;
    return sendRunArtifact(req, reply, owner, roots, parts.join('/'));
  };
  // These are aliases of one policy, not independent raw file servers.
  for (const prefix of ['/runner-logs/', '/_static/runner-logs/', '/runner/runner-logs/']) app.get(`${prefix}*`, handler);
  app.get('/runner/test-runs/:id/view', async (req: any, reply) => {
    const owner = await requireRunOwner(req, reply, req.params.id); if (!owner) return;
    return artifactSecurityResponse(reply);
  });
  for (const url of ['/runner/test-runs/:id/report.json', '/runner/tm/runs/:id/tests']) app.get(url, async (req: any, reply) => {
    const owner = await requireRunOwner(req, reply, req.params.id); if (!owner) return;
    return sendRunArtifact(req, reply, owner, roots, 'report.json');
  });
  app.get('/runner/test-runs/:id/logs', async (req: any, reply) => {
    const owner = await requireRunOwner(req, reply, req.params.id); if (!owner) return;
    return sendRunArtifact(req, reply, owner, roots, req.query?.type === 'stderr' ? 'stderr.txt' : 'stdout.txt');
  });
  app.get('/assets/*', async (req: any, reply) => {
    const match = String(req.headers.referer || '').match(/\/runner-logs\/([A-Za-z0-9_-]+)\//);
    if (!match) return reply.code(404).send({ error: 'Artifact not found' });
    const owner = await requireRunOwner(req, reply, match[1]); if (!owner) return;
    return sendRunArtifact(req, reply, owner, roots, `allure-report/${req.params['*'] || ''}`);
  });
  // This legacy directory has no run/project provenance, so it cannot authorize
  // an artifact download. Never publish an unscoped Playwright HTML/data bundle.
  app.get('/_static/playwright-report/*', async (_req, reply) => artifactSecurityResponse(reply));
}
