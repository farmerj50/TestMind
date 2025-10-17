// apps/api/src/testmind/routes.ts
import type { FastifyInstance, FastifyReply } from 'fastify';
import path from 'path';
import fs from 'fs';
// IMPORTANT: ESM-friendly import with .js extension, and both are named exports
import { generateAndWrite, runAdapter } from './service.js';

type GenerateBody = { repoPath?: string; baseUrl?: string; adapterId?: string; maxRoutes?: number };
type RunQuery = { baseUrl?: string; adapterId?: string };

const GENERATED_ROOT = process.env.TM_GENERATED_ROOT
  ? path.resolve(process.env.TM_GENERATED_ROOT)
  : path.resolve(process.cwd(), 'testmind-generated');

const IS_DEV = process.env.NODE_ENV !== 'production';

function sendError(app: FastifyInstance, reply: FastifyReply, err: unknown, code = 500) {
  const msg = (err as any)?.message ?? String(err);
  const stack = (err as any)?.stack;
  app.log.error(err);
  console.error('[TM] ERROR:', msg);
  if (IS_DEV && stack) console.error(stack);
  return reply.code(code).send({ ok: false, error: msg, ...(IS_DEV ? { stack } : {}) });
}

function assertDirExists(p: string) {
  if (!fs.existsSync(p) || !fs.statSync(p).isDirectory()) {
    throw new Error(`repoPath missing or not a directory: ${p}`);
  }
}
function assertUrl(u: string) {
  try { new URL(u); } catch { throw new Error(`Invalid baseUrl: ${u}`); }
}

export default async function testmindRoutes(app: FastifyInstance): Promise<void> {
  app.log.info({ GENERATED_ROOT }, '[TM] using generated output root');

  // POST /tm/generate
  app.post<{ Body: GenerateBody }>('/generate', async (req, reply) => {
    const t0 = Date.now();
    try {
      const {
        repoPath = path.resolve(process.cwd(), '../../'), // monorepo root
        baseUrl,
        adapterId = 'playwright-ts',
        maxRoutes,
      } = req.body || {};

      app.log.info({ repoPath, baseUrl, adapterId }, '[TM] /generate params');
      console.log('[TM] /generate params:', { repoPath, baseUrl, adapterId });

      if (!baseUrl) throw new Error('baseUrl is required');

      if (typeof maxRoutes === 'number' && Number.isFinite(maxRoutes)) {
        process.env.TM_MAX_ROUTES = String(maxRoutes);
      }
      console.log('[TM] TM_MAX_ROUTES:', process.env.TM_MAX_ROUTES);

      assertDirExists(repoPath);
      assertUrl(baseUrl);

      const outRoot = path.join(GENERATED_ROOT, adapterId);
      fs.mkdirSync(outRoot, { recursive: true });

      console.log('[TM] calling generateAndWrite', { repoPath, outRoot });
      const result = await generateAndWrite({ repoPath, outRoot, baseUrl, adapterId });
      console.log('[TM] generateAndWrite OK');

      const ms = Date.now() - t0;
      app.log.info({ ms, outRoot }, '[TM] /generate OK');
      return reply.send({ ok: true, adapterId, ...result });
    } catch (err) {
      console.log('[TM] /generate FAILED in', Date.now() - t0, 'ms');
      return sendError(app, reply, err, 500);
    }
  });

  // GET /tm/run/stream
  app.get<{ Querystring: RunQuery }>('/run/stream', async (req, reply: FastifyReply) => {
    try {
      const { baseUrl, adapterId = 'playwright-ts' } = req.query || {};
      app.log.info({ baseUrl, adapterId }, '[TM] /run/stream params');
      if (!baseUrl) throw new Error('baseUrl is required');
      assertUrl(baseUrl);

      const outRoot = path.join(GENERATED_ROOT, adapterId);

      reply.raw.setHeader('Content-Type', 'text/event-stream');
      reply.raw.setHeader('Cache-Control', 'no-cache, no-transform');
      reply.raw.setHeader('Connection', 'keep-alive');
      // @ts-ignore
      reply.raw.flushHeaders?.();

      const send = (line: string) =>
        reply.raw.write(`data: ${line.replace(/\r?\n/g, '\n')}\n\n`);

      try {
        const exitCode = await runAdapter({
          outRoot,
          adapterId,
          env: { TM_BASE_URL: baseUrl },
          onLine: (l: string) => { // <- typed param fixes ts(7006)
            if (IS_DEV) process.stdout.write(l);
            send(l);
          },
        });
        send(`[EXIT] code=${exitCode}`);
      } catch (inner) {
        app.log.error(inner, '[TM] runAdapter error');
        send(`[ERROR] ${(inner as any)?.message || String(inner)}`);
      } finally {
        reply.raw.end();
      }
    } catch (err) {
      return sendError(app, reply, err, 500);
    }
  });

  // GET /tm/generated/list
  app.get('/generated/list', async (req, reply) => {
    try {
      const { adapterId = 'playwright-ts' } = (req.query as any) || {};
      const root = path.join(GENERATED_ROOT, adapterId);
      console.log('[TM] /generated/list root:', root);

      if (!fs.existsSync(root)) return reply.send({ files: [] });

      const list: { path: string; size: number }[] = [];
      const walk = (dir: string, rel = '') => {
        for (const name of fs.readdirSync(dir)) {
          const abs = path.join(dir, name);
          const r = path.join(rel, name);
          const st = fs.statSync(abs);
          if (st.isDirectory()) walk(abs, r);
          else list.push({ path: r.replace(/\\/g, '/'), size: st.size });
        }
      };
      walk(root);
      app.log.info({ count: list.length }, '[TM] generated files listed');
      return reply.send({ root, files: list });
    } catch (err) {
      return sendError(app, reply as any, err, 500);
    }
  });

  // GET /tm/generated/file
  app.get('/generated/file', async (req, reply) => {
    try {
      const { adapterId = 'playwright-ts', file } = (req.query as any) || {};
      if (!file) return reply.code(400).send({ ok: false, error: 'file required' });

      const base = path.join(GENERATED_ROOT, adapterId);
      const abs = path.join(base, file);
      console.log('[TM] /generated/file read:', abs);

      if (!abs.startsWith(base)) return reply.code(400).send({ ok: false, error: 'bad path' });
      if (!fs.existsSync(abs)) return reply.code(404).send({ ok: false, error: 'not found' });

      reply.type('text/plain');
      return reply.send(fs.readFileSync(abs, 'utf8'));
    } catch (err) {
      return sendError(app, reply as any, err, 500);
    }
  });

  // GET /tm/health (for quick diagnosis)
  app.get('/health', async (req, reply) => {
    const repoDefault = path.resolve(process.cwd(), '../../');
    const adapterId = (req.query as any)?.adapterId || 'playwright-ts';
    const outRoot = path.join(GENERATED_ROOT, adapterId);
    const exists = (p: string) => {
      try { return fs.existsSync(p) ? (fs.statSync(p).isDirectory() ? 'dir' : 'file') : 'missing'; }
      catch { return 'error'; }
    };
    return reply.send({
      ok: true,
      cwd: process.cwd(),
      repoDefault,
      repoDefaultStatus: exists(repoDefault),
      generatedRoot: GENERATED_ROOT,
      outRoot,
      outRootStatus: exists(outRoot),
      node: process.version,
    });
  });
}
