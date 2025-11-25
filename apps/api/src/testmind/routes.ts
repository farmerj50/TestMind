// apps/api/src/testmind/routes.ts
import type { FastifyInstance, FastifyReply } from 'fastify';
import path from 'path';
import fs from 'fs';
import { globby } from "globby";


// IMPORTANT: ESM-friendly import with .js extension, and both are named exports
import { generateAndWrite, runAdapter } from './service.js';
import {
  CURATED_ROOT,
  readCuratedManifest,
  writeCuratedManifest,
  getCuratedProject,
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
};

type GenerateBody = GenerateCommon;
type GenerateQuery = GenerateCommon;
type RunQuery = { baseUrl?: string; adapterId?: string };

const GENERATED_ROOT = process.env.TM_GENERATED_ROOT
  ? path.resolve(process.env.TM_GENERATED_ROOT)
  : path.resolve(process.cwd(), 'testmind-generated');
type CuratedManifest = ReturnType<typeof readCuratedManifest>;

function listSpecProjects() {
  const base = [
    {
      id: "playwright-ts",
      name: "Generated (playwright-ts)",
      type: "generated" as const,
    },
    {
      id: "cucumber-js",
      name: "Generated (cucumber-js)",
      type: "generated" as const,
    },
    {
      id: "cypress-js",
      name: "Generated (cypress-js)",
      type: "generated" as const,
    },
    {
      id: "appium-js",
      name: "Generated (appium-js)",
      type: "generated" as const,
    },
    {
      id: "xctest",
      name: "Generated (xctest)",
      type: "generated" as const,
    },
  ];
  const curated = readCuratedManifest().projects.map((proj) => ({
    id: proj.id,
    name: proj.name || proj.id,
    type: "curated" as const,
    locked: proj.locked ?? [],
  }));
  return [...base, ...curated];
}

function setSpecLock(projectId: string, relativePath: string, locked: boolean) {
  const manifest = readCuratedManifest();
  const target = manifest.projects.find((p) => p.id === projectId);
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
  const curated = getCuratedProject(projectId);
  if (curated) {
    const rel = curated.root ?? projectId;
    const abs = path.resolve(CURATED_ROOT, rel);
    if (fs.existsSync(abs)) {
      return abs;
    }
  }

  const candidates = [
    optionalRoot ? path.resolve(optionalRoot) : null,
    path.join(GENERATED_ROOT, projectId),
    path.join(GENERATED_ROOT, projectId, "playwright"),
  ].filter(Boolean) as string[];

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error(`No spec root found for ${projectId}. Checked: ${candidates.join(", ")}`);
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

      const outRoot = path.join(GENERATED_ROOT, adapterId);
      fs.mkdirSync(outRoot, { recursive: true });

      const result = await generateAndWrite({
        repoPath,
        outRoot,
        baseUrl,
        adapterId,
        options: { include, exclude, maxRoutes, authEmail, authPassword },
      });

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

      const outRoot = path.join(GENERATED_ROOT, adapterId);
      fs.mkdirSync(outRoot, { recursive: true });

      const result = await generateAndWrite({
        repoPath,
        outRoot,
        baseUrl,
        adapterId,
        options: { include, exclude, maxRoutes, authEmail, authPassword },
      });

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
      const { adapterId = 'playwright-ts' } = (req.query as any) || {};
      const root = path.join(GENERATED_ROOT, adapterId);
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
      const { adapterId = 'playwright-ts', file } = (req.query as any) || {};
      if (!file) return reply.code(400).send({ ok: false, error: 'file required' });

      const base = path.join(GENERATED_ROOT, adapterId);
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
  app.get("/suite/projects", async (_req, reply) => {
    return { projects: listSpecProjects() };
  });
  app.patch("/suite/projects/:id", async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      const body = (req.body as any) || {};
      const newName = (body.name || "").trim();
      if (!newName) {
        return reply.code(400).send({ error: "name is required" });
      }
      const manifest = readCuratedManifest();
      const proj = manifest.projects.find((p) => p.id === id);
      if (!proj) {
        return reply.code(404).send({ error: "Project not found" });
      }
      proj.name = newName;
      writeCuratedManifest(manifest);
      return reply.send({ project: { id, name: newName, type: "curated", locked: proj.locked ?? [] } });
    } catch (err) {
      return sendError(app, reply, err);
    }
  });
  app.delete("/suite/projects/:id", async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      const manifest = readCuratedManifest();
      const idx = manifest.projects.findIndex((p) => p.id === id);
      if (idx === -1) {
        return reply.code(404).send({ error: "Project not found" });
      }
      const [proj] = manifest.projects.splice(idx, 1);
      writeCuratedManifest(manifest);
      const dir = path.resolve(CURATED_ROOT, proj.root ?? proj.id);
      await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
      return reply.code(204).send();
    } catch (err) {
      return sendError(app, reply, err);
    }
  });

  app.post("/suite/projects", async (req, reply) => {
    try {
      const body = (req.body as any) || {};
      const name = (body.name || "").trim();
      let requestedId = (body.id || "").trim();
      if (!name) {
        return reply.code(400).send({ error: "Name is required" });
      }

      if (requestedId && !/^[a-z0-9-]+$/i.test(requestedId)) {
        return reply.code(400).send({ error: "id must be alphanumeric/hyphen" });
      }

      const manifest = readCuratedManifest();
      let slug = requestedId || slugify(name);
      let attempt = slug;
      let suffix = 2;
      while (manifest.projects.some((p) => p.id === attempt)) {
        attempt = `${slug}-${suffix++}`;
      }
      slug = attempt;

      const rel = slug;
      const abs = path.resolve(CURATED_ROOT, rel);
      if (!fs.existsSync(abs)) {
        fs.mkdirSync(abs, { recursive: true });
      }

      manifest.projects.push({ id: slug, name, root: rel });
      writeCuratedManifest(manifest);

      return reply.code(201).send({
        project: { id: slug, name, type: "curated" },
      });
    } catch (err) {
      return sendError(app, reply, err);
    }
  });

  app.post("/suite/projects/:id/specs", async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      const destProject = getCuratedProject(id);
      if (!destProject) {
        return reply.code(404).send({ error: "Project not found" });
      }

      const body = (req.body as any) || {};
      const relativePath = (body.path || "").trim();
      if (!relativePath) {
        return reply.code(400).send({ error: "path is required" });
      }
      const sourceProjectId = (body.sourceProjectId || "playwright-ts").trim();

      const sourceRoot = await resolveProjectRoot(sourceProjectId);
      const destRoot = path.resolve(CURATED_ROOT, destProject.root ?? destProject.id);
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
      const { id } = req.params as { id: string };
      const body = (req.body as any) || {};
      const relPath = (body.path || "").trim();
      const lockedFlag = body.locked;
      if (!relPath || typeof lockedFlag !== "boolean") {
        return reply.code(400).send({ error: "path and locked flag are required" });
      }
      const proj = setSpecLock(id, relPath, lockedFlag);
      return reply.send({
        ok: true,
        projectId: id,
        locked: proj.locked ?? [],
      });
    } catch (err) {
      return sendError(app, reply, err);
    }
  });

  app.get("/suite/spec-content", async (req, reply) => {
    try {
      const { projectId, path: relPath } = (req.query as any) || {};
      if (!projectId || !relPath) {
        return reply.code(400).send({ error: "Missing projectId or path" });
      }
      const curated = getCuratedProject(projectId);
      if (!curated) {
        return reply.code(400).send({ error: "Only curated suites can be edited. Copy the spec first." });
      }
      const root = path.resolve(CURATED_ROOT, curated.root ?? curated.id);
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
      const body = (req.body as any) || {};
      const projectId = (body.projectId || "").trim();
      const relPath = (body.path || "").trim();
      const content = typeof body.content === "string" ? body.content : null;
      if (!projectId || !relPath || content === null) {
        return reply.code(400).send({ error: "projectId, path, and content are required" });
      }
      const curated = getCuratedProject(projectId);
      if (!curated) {
        return reply.code(400).send({ error: "Only curated suites can be edited. Copy the spec first." });
      }
      const root = path.resolve(CURATED_ROOT, curated.root ?? curated.id);
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
    const { projectId, root } = (req.query as any) || {};
    if (!projectId) return reply.code(400).send({ error: "Missing projectId" });

    const specRoot = await resolveProjectRoot(projectId, root);
    const files = await globby(["**/*.spec.{ts,js,mjs,cjs}"], { cwd: specRoot, dot: false });
    return files.map((rel: string) => ({ path: rel }));
  });

  // GET /tm/suite/cases?projectId=<id>&path=<repo-relative>&root=<optional>
  app.get("/suite/cases", async (req, reply) => {
    const { projectId, path: relPath, root } = (req.query as any) || {};
    if (!projectId || !relPath) return reply.code(400).send({ error: "Missing projectId or path" });

    const base = await resolveProjectRoot(projectId, root);
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



