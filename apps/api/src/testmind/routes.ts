// apps/api/src/testmind/routes.ts
import type { FastifyInstance, FastifyReply } from 'fastify';
import path from 'path';
import fs from 'fs';
import { globby } from "globby";
import { getAuth } from "@clerk/fastify";
import { prisma } from "../prisma.js";


// IMPORTANT: ESM-friendly import with .js extension, and both are named exports
import { generateAndWrite, runAdapter } from './service.js';
import {
  CURATED_ROOT,
  readCuratedManifest,
  writeCuratedManifest,
  slugify,
  ensureWithin,
} from "./curated-store.js";

type GenerateCommon = {
  repoPath?: string;
  baseUrl?: string;
  adapterId?: string;
  maxRoutes?: number;
  include?: string;      // comma-separated or single glob, e.g. "/*" or "/pricing,/contact"
  exclude?: string;      // comma-separated or single glob, e.g. "/admin*,/reset*"
  authEmail?: string;    // optional test user email
  authPassword?: string; // optional test user password
  projectId?: string;    // optional project id for scoped generated outputs
};

type GenerateBody = GenerateCommon;
type GenerateQuery = GenerateCommon;
type RunQuery = { baseUrl?: string; adapterId?: string; projectId?: string };

// Treat the monorepo root as two levels up from apps/api by default.
const REPO_ROOT = process.env.TM_LOCAL_REPO_ROOT
  ? path.resolve(process.env.TM_LOCAL_REPO_ROOT)
  : path.resolve(process.cwd(), '..', '..');

// If project ids are user-scoped (e.g., playwright-ts-user_xxx), strip the user suffix to resolve paths.
const stripUserSuffix = (projectId: string) => {
  const m = projectId.match(/^(.*)-(user_[A-Za-z0-9]+)$/);
  return m ? m[1] : projectId;
};
const extractUserSuffix = (projectId: string) => {
  const m = projectId.match(/^(.*)-(user_[A-Za-z0-9]+)$/);
  return m ? m[2] : null;
  };

// Determine where generated specs live.
// Priority: explicit env override -> repo-root/testmind-generated -> apps/web/testmind-generated
const GENERATED_ROOT = (() => {
  if (process.env.TM_GENERATED_ROOT) {
    return path.resolve(process.env.TM_GENERATED_ROOT);
  }
  const candidates = [
    path.join(REPO_ROOT, "testmind-generated"),
    path.join(REPO_ROOT, "apps", "web", "testmind-generated"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isDirectory()) return c;
  }
  return candidates[candidates.length - 1];
})();
type CuratedManifest = ReturnType<typeof readCuratedManifest>;

type CuratedSuiteWithOwner = {
  id: string;
  name: string;
  rootRel: string;
  projectId: string;
  ownerId: string;
};

async function listSpecProjectsForUser(userId: string) {
  const adapters = ["playwright-ts", "cucumber-js", "cypress-js", "appium-js", "xctest"];
  const generated = adapters
    .map((a) => ({
      id: `${a}-${userId}`,
      name: `Generated (${a})`,
      type: "generated" as const,
      dir: path.join(GENERATED_ROOT, `${a}-${userId}`),
      legacyDir: path.join(GENERATED_ROOT, a),
    }))
    .map((item) => {
      const { dir, legacyDir } = item;
      try {
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        // If this user directory is empty but a legacy shared folder exists, seed it by copying.
        const hasEntries =
          fs.existsSync(dir) &&
          fs.readdirSync(dir, { withFileTypes: true }).some((d) => d.name !== ".DS_Store");
        if (!hasEntries && fs.existsSync(legacyDir)) {
          try {
            fs.cpSync(legacyDir, dir, { recursive: true, force: false, errorOnExist: false });
          } catch (err) {
            console.warn("[TM] failed to copy legacy specs", { legacyDir, dir, err });
          }
        }
      } catch (err) {
        console.warn("[TM] failed to prepare generated suite", { dir, err });
      }
      const { dir: _dir, legacyDir: _legacyDir, ...rest } = item;
      return rest;
    }) as Array<{ id: string; name: string; type: "generated" }>;

  const curated: Array<{ id: string; name: string; type: "curated"; projectId: string }> = [];
  try {
    const suites = await prisma.curatedSuite.findMany({
      where: { project: { ownerId: userId } },
      select: { id: true, name: true, projectId: true },
      orderBy: { updatedAt: "desc" },
    });
    suites.forEach((s) => curated.push({ id: s.id, name: `${s.name} (curated)`, type: "curated", projectId: s.projectId }));
  } catch {
    // ignore curated fetch errors; still return generated
  }

  return [...generated, ...curated];
}

function setSpecLock(projectId: string, relativePath: string, locked: boolean, rootRel?: string, name?: string) {
  const manifest = readCuratedManifest();
  let target = manifest.projects.find((p) => p.id === projectId);
  if (!target && rootRel) {
    target = { id: projectId, name, root: rootRel, locked: [] };
    manifest.projects.push(target);
  }
  if (!target) throw new Error("Project not found");
  target.locked = target.locked ?? [];
  const idx = target.locked.indexOf(relativePath);
  if (locked && idx === -1) {
    target.locked.push(relativePath);
  } else if (!locked && idx !== -1) {
    target.locked.splice(idx, 1);
  }
  writeCuratedManifest(manifest);
  return target;
}

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
// --- helper: find this project's generated specs directory ---
async function resolveProjectRoot(projectId: string, optionalRoot?: string) {
  const userSuffix = extractUserSuffix(projectId);
  const hasUserSuffix = !!userSuffix;
  const baseId = stripUserSuffix(projectId);
  try {
    const curatedSuite = await prisma.curatedSuite.findUnique({
      where: { id: projectId },
      select: { rootRel: true },
    });
    if (curatedSuite) {
      const abs = path.resolve(CURATED_ROOT, curatedSuite.rootRel);
      if (fs.existsSync(abs)) return abs;
    }
  } catch {
    /* ignore */
  }

  const candidates = hasUserSuffix
    ? [
        optionalRoot ? path.resolve(optionalRoot) : null,
        // user-scoped generated directory (required when suffix present)
        path.join(GENERATED_ROOT, projectId),
      ].filter(Boolean) as string[]
    : ([
        optionalRoot ? path.resolve(optionalRoot) : null,
        path.join(GENERATED_ROOT, baseId),
        path.join(GENERATED_ROOT, baseId, "playwright"),
        // curated fallback (when generated specs are missing)
        path.join(CURATED_ROOT, baseId),
        path.join(CURATED_ROOT, baseId, "playwright-ts"),
        // monorepo fallbacks (legacy)
        path.join(REPO_ROOT, "apps", "api", "testmind-generated", "playwright-ts"),
        path.join(REPO_ROOT, "apps", "web", "testmind-generated", "playwright-ts"),
        path.join(REPO_ROOT, "testmind-generated", "playwright-ts"),
      ].filter(Boolean) as string[]);

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  // Fallback: create a home so new projects/users always have a root.
  if (hasUserSuffix) {
    const fallback = path.join(GENERATED_ROOT, projectId);
    try {
      fs.mkdirSync(fallback, { recursive: true });
      return fallback;
    } catch {
      /* ignore */
    }
    throw new Error(`No spec root found for ${projectId}. Checked: ${candidates.join(", ")}, fallback=${fallback}`);
  } else {
    // Non-suffixed IDs: treat as curated; create manifest entry and directory.
    throw new Error(`No spec root found for ${projectId}. Checked: ${candidates.join(", ")}`);
  }
}


// Render a simple HTML form to collect baseUrl and optional knobs
function renderGenerateForm(defaultBaseUrl = ''): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8"/>
    <title>Generate tests</title>
  </head>
  <body style="font-family:system-ui;max-width:720px;margin:40px auto;padding:0 16px">
    <h2>Generate tests</h2>
    <form method="GET" action="/tm/generate" style="display:block;margin-top:16px">
      <label style="display:block;margin:8px 0 4px">Base URL</label>
      <input name="baseUrl" placeholder="https://example.com"
             value="${defaultBaseUrl}"
             style="width:100%;padding:8px;border:1px solid #ccc;border-radius:6px"/>

      <div style="height:12px"></div>
      <label style="display:block;margin:8px 0 4px">Adapter</label>
      <input name="adapterId" value="playwright-ts"
             style="width:100%;padding:8px;border:1px solid #ccc;border-radius:6px"/>

      <div style="height:12px"></div>
      <label style="display:block;margin:8px 0 4px">Max Routes (optional)</label>
      <input name="maxRoutes" type="number" placeholder="50"
             style="width:100%;padding:8px;border:1px solid #ccc;border-radius:6px"/>

      <div style="height:12px"></div>
      <label style="display:block;margin:8px 0 4px">Include globs (comma-separated, optional)</label>
      <input name="include" placeholder="/*,/pricing"
             style="width:100%;padding:8px;border:1px solid #ccc;border-radius:6px"/>

      <div style="height:12px"></div>
      <label style="display:block;margin:8px 0 4px">Exclude globs (comma-separated, optional)</label>
      <input name="exclude" placeholder="/admin*,/reset*"
             style="width:100%;padding:8px;border:1px solid #ccc;border-radius:6px"/>

      <div style="height:12px"></div>
      <label style="display:block;margin:8px 0 4px">Auth Email (optional)</label>
      <input name="authEmail" placeholder="test-user@example.com"
             style="width:100%;padding:8px;border:1px solid #ccc;border-radius:6px"/>

      <div style="height:12px"></div>
      <label style="display:block;margin:8px 0 4px">Auth Password (optional)</label>
      <input name="authPassword" type="password" placeholder="••••••••"
             style="width:100%;padding:8px;border:1px solid #ccc;border-radius:6px"/>

      <div style="height:16px"></div>
      <button type="submit" style="padding:8px 12px;border:0;background:#111;color:#fff;border-radius:6px">
        Generate
      </button>
    </form>
  </body>
</html>`;
}

export default async function testmindRoutes(app: FastifyInstance): Promise<void> {
  app.log.info({ GENERATED_ROOT }, '[TM] using generated output root');
  const adapterDir = (adapterId: string, userId: string) =>
    path.join(GENERATED_ROOT, `${adapterId}-${userId}`);
  const adapterProjectDir = (adapterId: string, userId: string, projectId?: string) =>
    projectId ? path.join(adapterDir(adapterId, userId), projectId) : adapterDir(adapterId, userId);
  const webGeneratedRoot = path.join(REPO_ROOT, "apps", "web", "testmind-generated");

  async function mirrorGeneratedToWeb(
    repoPath: string,
    adapterId: string,
    userId: string,
    projectId: string | undefined,
    outRoot: string
  ) {
    const webRoot = path.resolve(repoPath, "apps", "web", "testmind-generated");
    const dest = projectId
      ? path.join(webRoot, `${adapterId}-${userId}`, projectId)
      : path.join(webRoot, `${adapterId}-${userId}`);
    const outResolved = path.resolve(outRoot);
    const destResolved = path.resolve(dest);
    if (outResolved.startsWith(webRoot)) return;
    await fs.promises.rm(destResolved, { recursive: true, force: true }).catch(() => {});
    await fs.promises.mkdir(path.dirname(destResolved), { recursive: true });
    await fs.promises.cp(outResolved, destResolved, { recursive: true });
  }

  function resolveGeneratedSource(
    adapterId: string,
    userId: string,
    projectId: string | undefined
  ) {
    const userFolder = `${adapterId}-${userId}`;
    const roots = [
      GENERATED_ROOT,
      webGeneratedRoot,
      path.join(REPO_ROOT, "apps", "api", "testmind-generated"),
      path.join(REPO_ROOT, "testmind-generated"),
    ];
    for (const root of roots) {
      const direct = projectId ? path.join(root, userFolder, projectId) : null;
      if (direct && fs.existsSync(direct)) return direct;
      const parent = path.join(root, userFolder);
      if (fs.existsSync(parent)) {
        if (projectId) {
          const nested = path.join(parent, projectId);
          if (fs.existsSync(nested)) return nested;
        }
        return parent;
      }
    }
    return null;
  }

  // ----------------------------------------------------------------------------
  // GET /tm/generate  (shows form if no baseUrl; runs generation if baseUrl given)
  // ----------------------------------------------------------------------------
  app.get<{ Querystring: GenerateQuery }>('/generate', async (req, reply) => {
    const t0 = Date.now();
    try {
      const {
        repoPath = path.resolve(process.cwd(), '../../'),
        baseUrl,
        adapterId = 'playwright-ts',
        maxRoutes,
        include,
        exclude,
        authEmail,
        authPassword,
        projectId,
      } = (req.query as GenerateQuery) || {};

      // If no baseUrl -> render the HTML form (restores old UX)
      if (!baseUrl) {
        reply.type('text/html').send(renderGenerateForm(''));
        return;
      }

      app.log.info(
        { repoPath, baseUrl, adapterId, include, exclude, maxRoutes, hasAuth: !!(authEmail && authPassword) },
        '[TM] GET /generate params'
      );

      if (typeof maxRoutes === 'number' && Number.isFinite(maxRoutes)) process.env.TM_MAX_ROUTES = String(maxRoutes);
      if (include) process.env.TM_INCLUDE = include;
      if (exclude) process.env.TM_EXCLUDE = exclude;
      if (authEmail) process.env.E2E_EMAIL = authEmail;
      if (authPassword) process.env.E2E_PASS = authPassword;

      assertDirExists(repoPath);
      assertUrl(baseUrl);

      const { userId } = getAuth(req);
      if (!userId) return reply.code(401).send({ error: "Unauthorized" });
      let sharedSteps: Record<string, any> | undefined;
      if (projectId) {
        const project = await prisma.project.findFirst({
          where: { id: projectId, ownerId: userId },
          select: { sharedSteps: true },
        });
        sharedSteps = (project?.sharedSteps ?? undefined) as Record<string, any> | undefined;
      }

      const outRoot = adapterProjectDir(adapterId, userId, projectId);
      try {
        await fs.promises.rm(outRoot, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      fs.mkdirSync(outRoot, { recursive: true });

      const result = await generateAndWrite({
        repoPath,
        outRoot,
        baseUrl,
        adapterId,
        options: { include, exclude, maxRoutes, authEmail, authPassword, sharedSteps },
      });
      try {
        await mirrorGeneratedToWeb(repoPath, adapterId, userId, projectId, outRoot);
      } catch (err) {
        app.log.warn({ err }, "[TM] failed to mirror generated specs to apps/web");
      }

      const ms = Date.now() - t0;
      app.log.info({ ms, outRoot }, '[TM] GET /generate OK');
      return reply.send({ ok: true, adapterId, ...result });
    } catch (err) {
      app.log.error(err, '[TM] GET /generate FAILED');
      return sendError(app, reply, err, 500);
    }
  });

  // ----------------------------------------------------------------------------
  // POST /tm/generate  (API style)
  // ----------------------------------------------------------------------------
  app.post<{ Body: GenerateBody }>('/generate', async (req, reply) => {
    const t0 = Date.now();
    try {
      const {
        repoPath = path.resolve(process.cwd(), '../../'), // monorepo root
        baseUrl,
        adapterId = 'playwright-ts',
        maxRoutes,
        include,
        exclude,
        authEmail,
        authPassword,
        projectId,
      } = req.body || {};

      app.log.info(
        { repoPath, baseUrl, adapterId, include, exclude, maxRoutes, hasAuth: !!(authEmail && authPassword) },
        '[TM] POST /generate params'
      );

      if (!baseUrl) throw new Error('baseUrl is required');

      if (typeof maxRoutes === 'number' && Number.isFinite(maxRoutes)) process.env.TM_MAX_ROUTES = String(maxRoutes);
      if (include) process.env.TM_INCLUDE = include;
      if (exclude) process.env.TM_EXCLUDE = exclude;
      if (authEmail) process.env.E2E_EMAIL = authEmail;
      if (authPassword) process.env.E2E_PASS = authPassword;

      assertDirExists(repoPath);
      assertUrl(baseUrl);

      const { userId } = getAuth(req);
      if (!userId) return reply.code(401).send({ error: "Unauthorized" });
      let sharedSteps: Record<string, any> | undefined;
      if (projectId) {
        const project = await prisma.project.findFirst({
          where: { id: projectId, ownerId: userId },
          select: { sharedSteps: true },
        });
        sharedSteps = (project?.sharedSteps ?? undefined) as Record<string, any> | undefined;
      }

      const outRoot = adapterProjectDir(adapterId, userId, projectId);
      try {
        await fs.promises.rm(outRoot, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      fs.mkdirSync(outRoot, { recursive: true });

      const result = await generateAndWrite({
        repoPath,
        outRoot,
        baseUrl,
        adapterId,
        options: { include, exclude, maxRoutes, authEmail, authPassword, sharedSteps },
      });
      try {
        await mirrorGeneratedToWeb(repoPath, adapterId, userId, projectId, outRoot);
      } catch (err) {
        app.log.warn({ err }, "[TM] failed to mirror generated specs to apps/web");
      }

      const ms = Date.now() - t0;
      app.log.info({ ms, outRoot }, '[TM] POST /generate OK');
      return reply.send({ ok: true, adapterId, ...result });
    } catch (err) {
      app.log.error(err, '[TM] POST /generate FAILED');
      return sendError(app, reply, err, 500);
    }
  });

  // ----------------------------------------------------------------------------
  // GET /tm/run/stream
  // ----------------------------------------------------------------------------
  app.get<{ Querystring: RunQuery }>('/run/stream', async (req, reply: FastifyReply) => {
    try {
      const { baseUrl, adapterId = 'playwright-ts', projectId } = req.query || {};
      app.log.info({ baseUrl, adapterId }, '[TM] /run/stream params');
      if (!baseUrl) throw new Error('baseUrl is required');
      assertUrl(baseUrl);

      const { userId } = getAuth(req);
      if (!userId) return reply.code(401).send({ error: "Unauthorized" });

      const runId = `run_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
      const outRoot = path.join(adapterProjectDir(adapterId, userId, projectId), runId);
      fs.mkdirSync(outRoot, { recursive: true });

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
          env: { TM_BASE_URL: baseUrl, TM_RUN_ID: runId },
          onLine: (l: string) => {
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

  // ----------------------------------------------------------------------------
  // GET /tm/generated/list
  // ----------------------------------------------------------------------------
  app.get('/generated/list', async (req, reply) => {
    try {
      const { userId } = getAuth(req);
      if (!userId) return reply.code(401).send({ error: "Unauthorized" });
      const { adapterId = 'playwright-ts', projectId } = (req.query as any) || {};
      let root = adapterProjectDir(adapterId, userId, projectId);
      if (projectId && !fs.existsSync(root)) {
        const fallback = adapterDir(adapterId, userId);
        if (fs.existsSync(fallback)) root = fallback;
      }
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

  // ----------------------------------------------------------------------------
  // GET /tm/generated/file
  // ----------------------------------------------------------------------------
  app.get('/generated/file', async (req, reply) => {
    try {
      const { userId } = getAuth(req);
      if (!userId) return reply.code(401).send({ error: "Unauthorized" });

      const { adapterId = 'playwright-ts', projectId, file } = (req.query as any) || {};
      if (!file) return reply.code(400).send({ ok: false, error: 'file required' });

      let base = adapterProjectDir(adapterId, userId, projectId);
      if (projectId && !fs.existsSync(base)) {
        const fallback = adapterDir(adapterId, userId);
        if (fs.existsSync(fallback)) base = fallback;
      }
      const abs = path.join(base, file);

      if (!abs.startsWith(base)) return reply.code(400).send({ ok: false, error: 'bad path' });
      if (!fs.existsSync(abs)) return reply.code(404).send({ ok: false, error: 'not found' });

      reply.type('text/plain');
      return reply.send(fs.readFileSync(abs, 'utf8'));
    } catch (err) {
      return sendError(app, reply as any, err, 500);
    }
  });
  // ---------------------------------------------------------------------------
  // NEW: Suite endpoints
  // ---------------------------------------------------------------------------

  // GET /tm/suite/projects -> list generated + curated spec roots
  app.get("/suite/projects", async (req, reply) => {
    const { userId } = getAuth(req);
    if (!userId) return reply.code(401).send({ error: "Unauthorized" });
    return { projects: await listSpecProjectsForUser(userId) };
  });
  app.patch("/suite/projects/:id", async (req, reply) => {
    try {
      const { userId } = getAuth(req);
      if (!userId) return reply.code(401).send({ error: "Unauthorized" });
      const { id } = req.params as { id: string };
      const body = (req.body as any) || {};
      const newName = (body.name || "").trim();
      if (!newName) {
        return reply.code(400).send({ error: "name is required" });
      }
      const suite = await prisma.curatedSuite.findUnique({
        where: { id },
        select: { id: true, name: true, rootRel: true, projectId: true, project: { select: { ownerId: true } } },
      });
      if (!suite || suite.project.ownerId !== userId) {
        return reply.code(404).send({ error: "Project not found" });
      }
      const updated = await prisma.curatedSuite.update({ where: { id }, data: { name: newName } });
      const manifest = readCuratedManifest();
      const existing = manifest.projects.find((p) => p.id === id);
      if (existing) {
        existing.name = newName;
      } else {
        manifest.projects.push({ id, name: newName, root: updated.rootRel, locked: [] });
      }
      writeCuratedManifest(manifest);
      return reply.send({ project: { id, name: newName, type: "curated", locked: existing?.locked ?? [] } });
    } catch (err) {
      return sendError(app, reply, err);
    }
  });
  app.delete("/suite/projects/:id", async (req, reply) => {
    try {
      const { userId } = getAuth(req);
      if (!userId) return reply.code(401).send({ error: "Unauthorized" });
      const { id } = req.params as { id: string };
      const suite = await prisma.curatedSuite.findUnique({
        where: { id },
        select: { rootRel: true, project: { select: { ownerId: true } } },
      });
      if (!suite || suite.project.ownerId !== userId) {
        return reply.code(404).send({ error: "Project not found" });
      }
      await prisma.curatedSuite.delete({ where: { id } });
      const manifest = readCuratedManifest();
      const idx = manifest.projects.findIndex((p) => p.id === id);
      if (idx !== -1) manifest.projects.splice(idx, 1);
      writeCuratedManifest(manifest);
      const dir = path.resolve(CURATED_ROOT, suite.rootRel);
      await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
      return reply.code(204).send();
    } catch (err) {
      return sendError(app, reply, err);
    }
  });

  app.post("/suite/projects", async (req, reply) => {
    try {
      const { userId } = getAuth(req);
      if (!userId) return reply.code(401).send({ error: "Unauthorized" });

      const body = (req.body as any) || {};
      const name = (body.name || "").trim();
      const projectId = (body.projectId || "").trim();
      if (!name || !projectId) {
        return reply.code(400).send({ error: "projectId and name are required" });
      }

      const proj = await prisma.project.findUnique({
        where: { id: projectId },
        select: { ownerId: true },
      });
      if (!proj || proj.ownerId !== userId) {
        return reply.code(404).send({ error: "Project not found" });
      }

      const slug = slugify(name);
      const rootRel = `project-${projectId}/${slug}`;
      const abs = path.resolve(CURATED_ROOT, rootRel);
      fs.mkdirSync(abs, { recursive: true });

      const suite = await prisma.curatedSuite.create({
        data: { projectId, name, rootRel },
      });

      const manifest = readCuratedManifest();
      const existing = manifest.projects.find((p) => p.id === suite.id);
      if (existing) {
        existing.name = suite.name;
        existing.root = suite.rootRel;
      } else {
        manifest.projects.push({ id: suite.id, name: suite.name, root: suite.rootRel, locked: [] });
      }
      writeCuratedManifest(manifest);

      return reply.code(201).send({
        project: { id: suite.id, name: suite.name, type: "curated", projectId },
      });
    } catch (err) {
      return sendError(app, reply, err);
    }
  });

  // Sync a curated suite from generated specs
  app.post("/suite/projects/:id/sync-from-generated", async (req, reply) => {
    try {
      const { userId } = getAuth(req);
      if (!userId) return reply.code(401).send({ error: "Unauthorized" });
      const { id } = req.params as { id: string };
      const body = (req.body as any) || {};
      const adapterId = (body.adapterId || "playwright-ts").trim();
      const mode = (body.mode || "replaceSuite") as "replaceSuite" | "overwriteMatches" | "addMissing";

      const suite = await prisma.curatedSuite.findUnique({
        where: { id },
        select: { id: true, name: true, rootRel: true, projectId: true, project: { select: { ownerId: true } } },
      });
      if (!suite || suite.project.ownerId !== userId) {
        return reply.code(404).send({ error: "Project not found" });
      }

      let targetSuite = suite;
      let createdSuite: { id: string; name: string; rootRel: string; projectId: string } | null = null;
      if (suite.projectId) {
        const agentId = `agent-${suite.projectId}`;
        if (suite.projectId && id === agentId) {
          const existing = await prisma.curatedSuite.findFirst({
            where: {
              projectId: suite.projectId,
              id: { not: agentId },
              project: { ownerId: userId },
            },
            select: { id: true, name: true, rootRel: true, projectId: true },
            orderBy: { updatedAt: "desc" },
          });
          if (existing) {
            targetSuite = { ...suite, ...existing };
          } else {
            const project = await prisma.project.findUnique({
              where: { id: suite.projectId },
              select: { name: true },
            });
            const suiteName = `${project?.name ?? "Project"} Suite`;
            const slug = slugify(suiteName);
            const rootRel = `project-${suite.projectId}/${slug}`;
            const created = await prisma.curatedSuite.create({
              data: { projectId: suite.projectId, name: suiteName, rootRel },
              select: { id: true, name: true, rootRel: true, projectId: true },
            });
            const manifest = readCuratedManifest();
            const existingEntry = manifest.projects.find((p) => p.id === created.id);
            if (existingEntry) {
              existingEntry.name = created.name;
              existingEntry.root = created.rootRel;
            } else {
              manifest.projects.push({ id: created.id, name: created.name, root: created.rootRel, locked: [] });
            }
            writeCuratedManifest(manifest);
            createdSuite = created;
            targetSuite = { ...suite, ...created };
          }
        }
      }

      const projectRoot = targetSuite.projectId
        ? resolveGeneratedSource(adapterId, userId, targetSuite.projectId)
        : null;
      const sourceRoot =
        projectRoot ?? resolveGeneratedSource(adapterId, userId, undefined) ?? path.join(GENERATED_ROOT, `${adapterId}-${userId}`);
      if (!fs.existsSync(sourceRoot)) {
        return reply.code(404).send({ error: `No generated specs found for ${adapterId}` });
      }

      const destRoot = path.resolve(CURATED_ROOT, targetSuite.rootRel);
      fs.mkdirSync(destRoot, { recursive: true });

      if (mode === "replaceSuite") {
        await fs.promises.rm(destRoot, { recursive: true, force: true }).catch(() => {});
        await fs.promises.mkdir(destRoot, { recursive: true });
      }

      const existingSet = new Set<string>();
      let destHasFiles = false;
      if (mode === "overwriteMatches" || mode === "addMissing") {
        const existing = await globby(["**/*.spec.{ts,js,mjs,cjs}"], { cwd: destRoot, dot: false, onlyFiles: true });
        destHasFiles = existing.length > 0;
        if (mode === "overwriteMatches") {
          existing.forEach((f) => existingSet.add(f.replace(/\\/g, "/")));
        }
      }

      const files = await globby(["**/*.spec.{ts,js,mjs,cjs}"], { cwd: sourceRoot, dot: false, onlyFiles: true });
      const copied: string[] = [];
      const skipped: string[] = [];
      for (const rel of files) {
        const relPosix = rel.replace(/\\/g, "/");
        const src = path.resolve(sourceRoot, rel);
        const dest = path.resolve(destRoot, rel);
        ensureWithin(sourceRoot, src);
        ensureWithin(destRoot, dest);

        const exists = fs.existsSync(dest);
        if (mode === "overwriteMatches" && destHasFiles && !exists && !existingSet.has(relPosix)) {
          skipped.push(relPosix);
          continue;
        }
        if (mode === "addMissing" && destHasFiles && exists) {
          skipped.push(relPosix);
          continue;
        }

        await fs.promises.mkdir(path.dirname(dest), { recursive: true });
        await fs.promises.copyFile(src, dest);
        copied.push(relPosix);
      }

      return reply.send({
        ok: true,
        mode,
        copied,
        skipped,
        suiteId: targetSuite.id,
        suiteName: createdSuite?.name,
        project: createdSuite ? { id: createdSuite.id, name: createdSuite.name, type: "curated", projectId: createdSuite.projectId } : undefined,
      });
    } catch (err) {
      return sendError(app, reply, err);
    }
  });

  app.post("/suite/projects/:id/specs", async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      const { userId } = getAuth(req);
      if (!userId) return reply.code(401).send({ error: "Unauthorized" });
      const destSuite = await prisma.curatedSuite.findUnique({
        where: { id },
        select: { rootRel: true, project: { select: { ownerId: true } } },
      });
      if (!destSuite || destSuite.project.ownerId !== userId) {
        return reply.code(404).send({ error: "Project not found" });
      }

      const body = (req.body as any) || {};
      const relativePath = (body.path || "").trim();
      if (!relativePath) {
        return reply.code(400).send({ error: "path is required" });
      }
      const sourceProjectId = (body.sourceProjectId || "playwright-ts").trim();

      const sourceRoot = await resolveProjectRoot(sourceProjectId);
      const destRoot = path.resolve(CURATED_ROOT, destSuite.rootRel);
      const sourceAbs = path.resolve(sourceRoot, relativePath);
      const destAbs = path.resolve(destRoot, relativePath);

      ensureWithin(sourceRoot, sourceAbs);
      await fs.promises.stat(sourceAbs);
      ensureWithin(destRoot, destAbs);
      await fs.promises.mkdir(path.dirname(destAbs), { recursive: true });
      await fs.promises.copyFile(sourceAbs, destAbs);

      return reply.code(201).send({
        ok: true,
        projectId: id,
        path: relativePath,
      });
    } catch (err) {
      return sendError(app, reply, err);
    }
  });

  app.patch("/suite/projects/:id/specs", async (req, reply) => {
    try {
      const { userId } = getAuth(req);
      if (!userId) return reply.code(401).send({ error: "Unauthorized" });
      const { id } = req.params as { id: string };
      const body = (req.body as any) || {};
      const relPath = (body.path || "").trim();
      const lockedFlag = body.locked;
      if (!relPath || typeof lockedFlag !== "boolean") {
        return reply.code(400).send({ error: "path and locked flag are required" });
      }
      const suite = await prisma.curatedSuite.findUnique({
        where: { id },
        select: { rootRel: true, project: { select: { ownerId: true } } },
      });
      if (!suite || suite.project.ownerId !== userId) {
        return reply.code(404).send({ error: "Project not found" });
      }
      const proj = setSpecLock(id, relPath, lockedFlag, suite.rootRel);
      return reply.send({
        ok: true,
        projectId: id,
        locked: proj.locked ?? [],
      });
    } catch (err) {
      return sendError(app, reply, err);
    }
  });

  // Delete a single spec from a curated suite
  app.delete("/suite/projects/:id/specs", async (req, reply) => {
    try {
      const { userId } = getAuth(req);
      if (!userId) return reply.code(401).send({ error: "Unauthorized" });
      const { id } = req.params as { id: string };
      const { path: relPath } = (req.query as any) || {};
      const bodyPath = (req.body as any)?.path;
      const targetPath = (relPath || bodyPath || "").trim();
      if (!targetPath) return reply.code(400).send({ error: "path is required" });

      const suite = await prisma.curatedSuite.findUnique({
        where: { id },
        select: { rootRel: true, project: { select: { ownerId: true } } },
      });
      if (!suite || suite.project.ownerId !== userId) {
        return reply.code(404).send({ error: "Project not found" });
      }

      const root = path.resolve(CURATED_ROOT, suite.rootRel);
      const abs = path.resolve(root, targetPath);
      ensureWithin(root, abs);
      const exists = fs.existsSync(abs);
      if (exists) {
        await fs.promises.rm(abs, { force: true });
        // clean up empty dirs up to root
        let dir = path.dirname(abs);
        while (dir.startsWith(root)) {
          try {
            const entries = fs.readdirSync(dir);
            if (entries.length) break;
            fs.rmdirSync(dir);
          } catch {
            break;
          }
          dir = path.dirname(dir);
        }
      }

      // remove from manifest locked list if present
      const manifest = readCuratedManifest();
      const proj = manifest.projects.find((p) => p.id === id);
      if (proj?.locked?.length) {
        proj.locked = proj.locked.filter((p) => p !== targetPath);
        writeCuratedManifest(manifest);
      }

      return reply.code(exists ? 200 : 404).send({ ok: exists, deleted: exists });
    } catch (err) {
      return sendError(app, reply, err);
    }
  });

  app.get("/suite/spec-content", async (req, reply) => {
    try {
      const { userId } = getAuth(req);
      if (!userId) return reply.code(401).send({ error: "Unauthorized" });
      const { projectId, path: relPath } = (req.query as any) || {};
      if (!projectId || !relPath) {
        return reply.code(400).send({ error: "Missing projectId or path" });
      }
      const suite = await prisma.curatedSuite.findUnique({
        where: { id: projectId },
        select: { rootRel: true, project: { select: { ownerId: true } } },
      });
      if (!suite || suite.project.ownerId !== userId) {
        return reply.code(400).send({ error: "Only curated suites can be edited. Copy the spec first." });
      }
      const root = path.resolve(CURATED_ROOT, suite.rootRel);
      const abs = path.resolve(root, relPath);
      ensureWithin(root, abs);
      if (!fs.existsSync(abs)) {
        return reply.code(404).send({ error: "Spec not found in curated suite" });
      }
      const content = await fs.promises.readFile(abs, "utf8");
      return { content };
    } catch (err) {
      return sendError(app, reply, err);
    }
  });

  app.put("/suite/spec-content", async (req, reply) => {
    try {
      const { userId } = getAuth(req);
      if (!userId) return reply.code(401).send({ error: "Unauthorized" });
      const body = (req.body as any) || {};
      const projectId = (body.projectId || "").trim();
      const relPath = (body.path || "").trim();
      const content = typeof body.content === "string" ? body.content : null;
      if (!projectId || !relPath || content === null) {
        return reply.code(400).send({ error: "projectId, path, and content are required" });
      }
      const suite = await prisma.curatedSuite.findUnique({
        where: { id: projectId },
        select: { rootRel: true, project: { select: { ownerId: true } } },
      });
      if (!suite || suite.project.ownerId !== userId) {
        return reply.code(400).send({ error: "Only curated suites can be edited. Copy the spec first." });
      }
      const root = path.resolve(CURATED_ROOT, suite.rootRel);
      const abs = path.resolve(root, relPath);
      ensureWithin(root, abs);
      await fs.promises.mkdir(path.dirname(abs), { recursive: true });
      await fs.promises.writeFile(abs, content, "utf8");
      return { ok: true };
    } catch (err) {
      return sendError(app, reply, err);
    }
  });

  // GET /tm/suite/specs?projectId=<id>&root=<optional override>
  app.get("/suite/specs", async (req, reply) => {
    const { userId } = getAuth(req);
    if (!userId) return reply.code(401).send({ error: "Unauthorized" });

    const { projectId, root } = (req.query as any) || {};
    if (!projectId) return reply.code(400).send({ error: "Missing projectId" });

    // Allow either user-suffixed generated suites OR projects owned by this user.
    let isAllowed = projectId.endsWith(userId);
    let curatedSuite: CuratedSuiteWithOwner | null = null;
    if (!isAllowed) {
      try {
        const suite = await prisma.curatedSuite.findUnique({
          where: { id: projectId },
          select: {
            id: true,
            name: true,
            rootRel: true,
            projectId: true,
            project: { select: { ownerId: true } },
          },
        });
        if (suite && suite.project.ownerId === userId) {
          curatedSuite = {
            id: suite.id,
            name: suite.name,
            rootRel: suite.rootRel,
            projectId: suite.projectId,
            ownerId: suite.project.ownerId,
          };
          isAllowed = true;
        } else {
          const proj = await prisma.project.findUnique({
            where: { id: projectId },
            select: { ownerId: true },
          });
          if (proj?.ownerId === userId) isAllowed = true;
        }
      } catch {
        /* ignore */
      }
    }
    if (!isAllowed) return reply.code(404).send({ error: "Suite not found" });

    try {
      const specRoot = curatedSuite
        ? path.resolve(CURATED_ROOT, curatedSuite.rootRel)
        : await resolveProjectRoot(projectId, root);
      const files = await globby(["**/*.spec.{ts,js,mjs,cjs}"], { cwd: specRoot, dot: false });
      return files.map((rel: string) => ({ path: rel }));
    } catch {
      // Last resort: return empty list so UI can still render and allow new suites to be created.
      return [];
    }
  });

  // GET /tm/suite/cases?projectId=<id>&path=<repo-relative>&root=<optional>
  app.get("/suite/cases", async (req, reply) => {
    const { userId } = getAuth(req);
    if (!userId) return reply.code(401).send({ error: "Unauthorized" });

    const { projectId, path: relPath, root } = (req.query as any) || {};
    if (!projectId || !relPath) return reply.code(400).send({ error: "Missing projectId or path" });

    // Allow either user-suffixed generated suites OR projects owned by this user.
    let isAllowed = projectId.endsWith(userId);
    let curatedSuite: CuratedSuiteWithOwner | null = null;
    if (!isAllowed) {
      try {
        const suite = await prisma.curatedSuite.findUnique({
          where: { id: projectId },
          select: {
            id: true,
            name: true,
            rootRel: true,
            projectId: true,
            project: { select: { ownerId: true } },
          },
        });
        if (suite && suite.project.ownerId === userId) {
          curatedSuite = {
            id: suite.id,
            name: suite.name,
            rootRel: suite.rootRel,
            projectId: suite.projectId,
            ownerId: suite.project.ownerId,
          };
          isAllowed = true;
        } else {
          const proj = await prisma.project.findUnique({
            where: { id: projectId },
            select: { ownerId: true },
          });
          if (proj?.ownerId === userId) isAllowed = true;
        }
      } catch {
        /* ignore */
      }
    }
    if (!isAllowed) return reply.code(404).send({ error: "Suite not found" });

    try {
      const base = curatedSuite
        ? path.resolve(CURATED_ROOT, curatedSuite.rootRel)
        : await resolveProjectRoot(projectId, root);
      const abs = path.join(base, relPath);
      if (!fs.existsSync(abs)) {
        return [];
      }
      const src = await fs.promises.readFile(abs, "utf8");

    const CASE_RE = /\b(?:test|it)(?:\.(?:only|skip))?\s*\(\s*['"`]([^'"`]+)['"`]\s*,/g;
    const out: Array<{ title: string; line: number }> = [];

    const lines = src.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      let m: RegExpExecArray | null;
      CASE_RE.lastIndex = 0;
      while ((m = CASE_RE.exec(line))) out.push({ title: m[1], line: i + 1 });
    }
      return out;
    } catch {
      // If we still can't read cases, treat as empty so the UI can proceed.
      return [];
    }
  });

  // ----------------------------------------------------------------------------
  // GET /tm/health
  // ----------------------------------------------------------------------------
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

  app.get('/runs/:id/tests', async (req, reply) => {
    try {
      const runId = (req.params as any).id as string;
      const outDir = path.join(GENERATED_ROOT, runId);
      const jsonPath = path.join(outDir, 'report.json');

      if (!fs.existsSync(jsonPath)) {
        return reply.code(404).send({ ok: false, error: 'report.json not found for this run' });
      }

      const raw = fs.readFileSync(jsonPath, 'utf-8');
      const report = JSON.parse(raw);

      const rows: Array<{ title: string; file: string; status: string; duration: number }> = [];

      const walk = (node: any, file?: string) => {
        if (!node) return;
        if (node.file) file = node.file;
        if (node.tests) {
          for (const t of node.tests) {
            const res = t.results?.[0];
            rows.push({
              title: t.titlePath?.join(' › ') || t.title,
              file: file || t.location?.file || 'unknown',
              status: res?.status || t.outcome || 'unknown',
              duration: res?.duration || 0,
            });
          }
        }
        if (node.suites) node.suites.forEach((s: any) => walk(s, file));
        if (node.specs) node.specs.forEach((s: any) => walk(s, s.file || file));
      };

      walk(report);
      return reply.send({ tests: rows });
    } catch (err: any) {
      return sendError(app, reply as any, err, 500);
    }
  });


}
// apps/api/src/testmind/runtime/routes.ts
export async function discoverRoutesFromRepo(_repoPath: string) {
  return { routes: ["/", "/pricing", "/login", "/signup", "/case-type-selection"] };
}
