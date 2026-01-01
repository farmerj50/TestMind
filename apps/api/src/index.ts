// apps/api/src/index.ts
import "dotenv/config";

console.log("[BOOT] INDEX_TS_RUNNING", new Date().toISOString());
import Fastify from "fastify";
import cors from "@fastify/cors";
import { clerkPlugin, getAuth } from "@clerk/fastify";
import { z } from "zod";

import fastifyStatic from "@fastify/static";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

import { githubRoutes } from "./routes/github.js";
import { testRoutes } from "./routes/tests.js";
import runRoutes from "./routes/run.js";
import reportsRoutes from "./routes/reports.js";
import integrationsRoutes from "./routes/integrations.js";
import agentRoutes from "./routes/agent.js";
import jiraRoutes from "./routes/jira.js";
import { secretsRoutes } from "./routes/secrets.js";
import qaAgentRoutes from "./routes/qaAgent.js";
import securityRoutes from "./routes/security.js";
import { prisma } from "./prisma.js";
import { validatedEnv } from "./config/env.js";
import recorderRoutes from "./routes/recorder.js";
import { GENERATED_ROOT, REPORT_ROOT, ensureStorageDirs } from "./lib/storageRoots.js";
import { generateAndWrite } from "./testmind/service.js";

// ✅ single source of truth for plan typing + limits
import { getLimitsForPlan } from "./config/plans.js";
import type { PlanTier } from "./config/plans.js";
import { PAID_PLANS, STRIPE_PRICE_IDS, type PaidPlan } from "./config/stripe.js";
import { requireStripe } from "./lib/stripe.js";
import testmindRoutes from './testmind/routes.js';
import type { FastifyCorsOptions } from "@fastify/cors";




const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? "info",
  },
  trustProxy: true,
  pluginTimeout: 10_000,
});
await ensureStorageDirs();

const registerWithLog = async (label: string, fn: () => unknown) => {
  console.log(`[BOOT] register ${label} start`);
  await toVoidPromise(fn());
  console.log(`[BOOT] register ${label} done`);
};

const resolveRepoRoot = () =>
  process.env.TM_LOCAL_REPO_ROOT
    ? path.resolve(process.env.TM_LOCAL_REPO_ROOT)
    : path.resolve(process.cwd(), "..", "..");

const scheduleSpecRegeneration = (params: {
  projectId: string;
  userId: string;
  baseUrl?: string;
  sharedSteps: Record<string, any>;
}) => {
  const { projectId, userId, baseUrl, sharedSteps } = params;
  const trimmedBaseUrl = typeof baseUrl === "string" ? baseUrl.trim() : "";
  if (!trimmedBaseUrl) return;
  setImmediate(async () => {
    try {
      const adapterId = "playwright-ts";
      const repoRoot = resolveRepoRoot();
      const outRoot = path.join(GENERATED_ROOT, `${adapterId}-${userId}`, projectId);
      await generateAndWrite({
        repoPath: repoRoot,
        outRoot,
        baseUrl: trimmedBaseUrl,
        adapterId,
        options: { sharedSteps },
      });
      const webOutRoot = path.join(
        repoRoot,
        "apps",
        "web",
        "testmind-generated",
        `${adapterId}-${userId}`,
        projectId
      );
      await fs.promises.rm(webOutRoot, { recursive: true, force: true }).catch(() => {});
      await fs.promises.mkdir(path.dirname(webOutRoot), { recursive: true });
      await fs.promises.cp(outRoot, webOutRoot, { recursive: true });
      console.log(`[locators] regenerated specs for project ${projectId}`);
    } catch (err) {
      console.warn("[locators] regenerate specs failed", err);
    }
  });
};

app.addHook("onRequest", async (req) => {
  const origin = req.headers.origin;
  req.log.info(
    {
      method: req.method,
      url: req.url,
      origin,
      requestId: req.id,
      ip: req.ip,
      host: req.headers.host,
      ua: req.headers["user-agent"],
    },
    "[HTTP] request"
  );
});

app.addHook("onResponse", async (req, reply) => {
  req.log.info(
    {
      method: req.method,
      url: req.url,
      statusCode: reply.statusCode,
      requestId: req.id,
    },
    "[HTTP] response"
  );
});
const REPO_ROOT = path.resolve(process.cwd(), "..", "..");


const normalizeOrigin = (o: string) => o.trim().replace(/\/$/, "");

const allowedOrigins = (validatedEnv.CORS_ALLOWED_ORIGINS ?? []).map(normalizeOrigin).filter(Boolean);
const raw = validatedEnv.CORS_ORIGINS_RAW ?? "";

app.log.info(`[CORS] raw=${raw} allowed=${allowedOrigins.join(" | ") || "(empty)"}`);

const fatalError = (label: string, err?: unknown) => {
  app.log.error({ err }, `[boot] ${label}`);
  console.error(`[BOOT] ${label}`, err);
  process.exit(1);
};
process.on("unhandledRejection", (err) => fatalError("unhandledRejection", err));
process.on("uncaughtException", (err) => fatalError("uncaughtException", err));
process.on("SIGTERM", () => {
  app.log.warn("[boot] SIGTERM received; shutting down");
  process.exit(1);
});

const buildStamp = process.env.BUILD_STAMP ?? process.env.GIT_SHA ?? "unknown";
app.log.info({ buildStamp }, "[boot] build stamp");

function toVoidPromise(x: unknown): Promise<void> {
  return Promise.resolve(x as any).then(() => {});
}

const getPlatformPort = () => {
  const rawPort = process.env.PORT;
  if (!rawPort) {
    fatalError("missing PORT env (Railway should inject this)");
  }
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    fatalError("invalid PORT env", rawPort);
  }
  return port;
};



// const corsOpts: FastifyCorsOptions = {
//   origin: (origin, cb) => {
//     if (!origin) return cb(null, true);

//     const normalized = origin.trim().replace(/\/$/, "");
//     const ok = allowedOrigins.includes(normalized);

//     app.log.info({ origin, normalized, ok }, "[CORS] origin check");
//     cb(null, ok);
//   },
//   credentials: true,
//   methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
//   exposedHeaders: ["set-cookie"],
//   optionsSuccessStatus: 204,
// };

await registerWithLog("cors", () =>
  app.register(cors, {
    origin: (origin, cb) => {
      // allow server-to-server / curl
      if (!origin) return cb(null, true);

      const normalized = normalizeOrigin(origin);
      const ok = allowedOrigins.includes(normalized);

      // DEBUG: log every origin decision
      app.log.info({ origin, normalized, ok }, "[CORS] check");

      cb(null, ok);
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "X-Requested-With",
      "X-Clerk-Auth",
      "X-Clerk-Session",
      "X-Clerk-Client",
      "X-Clerk-Signature",
      "X-Clerk-Redirect-To",
    ],
    exposedHeaders: ["set-cookie"],
    preflightContinue: false,
    optionsSuccessStatus: 204,
  })
);



const shouldStartWorkers = validatedEnv.START_WORKERS;
// force server to always listen in production
//const skipServer = validatedEnv.NODE_ENV !== "production" && validatedEnv.TM_SKIP_SERVER;

const globalState = globalThis as typeof globalThis & { __tmWorkersStarted?: boolean };
const recorderState = globalThis as typeof globalThis & { __tmRecorderHelperStarted?: boolean };
const allowDebugRoutes =
  validatedEnv.NODE_ENV !== "production" || validatedEnv.ENABLE_DEBUG_ROUTES;
const disableRecorderRoutes = ["1", "true"].includes((process.env.TM_DISABLE_RECORDER ?? "").toLowerCase());
const printRoutesEnabled = (process.env.TM_PRINT_ROUTES ?? "").toLowerCase() === "1";


await registerWithLog("clerk", () =>
  app.register(clerkPlugin, {
    publishableKey: validatedEnv.CLERK_PUBLISHABLE_KEY,
    secretKey: validatedEnv.CLERK_SECRET_KEY,
  })
);

await registerWithLog("githubRoutes", () => app.register(githubRoutes));
await registerWithLog("testRoutes", () => app.register(testRoutes));
await registerWithLog("runRoutes", () => app.register(runRoutes, { prefix: "/runner" }));
await registerWithLog("reportsRoutes", () => app.register(reportsRoutes, { prefix: "/" }));
await registerWithLog("integrationsRoutes", () => app.register(integrationsRoutes, { prefix: "/" }));
await registerWithLog("agentRoutes", () => app.register(agentRoutes, { prefix: "/" }));
await registerWithLog("jiraRoutes", () => app.register(jiraRoutes, { prefix: "/" }));
await registerWithLog("secretsRoutes", () => app.register(secretsRoutes, { prefix: "/" }));
await registerWithLog("qaAgentRoutes", () => app.register(qaAgentRoutes, { prefix: "/" }));
await registerWithLog("securityRoutes", () => app.register(securityRoutes, { prefix: "/" }));
await registerWithLog("testmindRoutes", () => app.register(testmindRoutes, { prefix: "/tm" }));
console.log("[BOOT] TM_DISABLE_RECORDER =", process.env.TM_DISABLE_RECORDER);
if (disableRecorderRoutes) {
  app.log.warn("[boot] recorderRoutes DISABLED via TM_DISABLE_RECORDER");
} else {
  await registerWithLog("recorderRoutes", () => app.register(recorderRoutes, { prefix: "/" }));
}
const PLAYWRIGHT_REPORT_ROOT = path.join(REPO_ROOT, "playwright-report");
if (fs.existsSync(PLAYWRIGHT_REPORT_ROOT)) {
  await registerWithLog("playwrightStatic", () =>
    app.register(fastifyStatic, {
      root: PLAYWRIGHT_REPORT_ROOT,
      prefix: "/_static/playwright-report/",
      decorateReply: false,
    })
  );
}
const RUNNER_LOGS_ROOT = path.join(REPORT_ROOT, "runner-logs");
const API_RUNNER_LOGS_ROOT = path.join(REPO_ROOT, "apps", "api", "runner-logs");
const LEGACY_RUNNER_LOGS_ROOT = path.join(REPO_ROOT, "runner-logs");
const AVAILABLE_RUNNER_ROOTS = [RUNNER_LOGS_ROOT, API_RUNNER_LOGS_ROOT, LEGACY_RUNNER_LOGS_ROOT];
await registerWithLog("runnerLogsStatic", () =>
  app.register(fastifyStatic, {
    root: RUNNER_LOGS_ROOT,
    prefix: "/_static/runner-logs/",
    decorateReply: false,
  })
);

// Serve runner artifacts (e.g., allure) directly from either runner-logs root
app.get("/runner-logs/*", async (req, reply) => {
  const splat = (req.params as any)["*"] as string | undefined;
  const parts = (splat || "").split("/").filter(Boolean);
  const id = parts.shift();
  if (!id) return reply.code(404).send("Not found");
  const rest = parts.join("/");
  const roots = [RUNNER_LOGS_ROOT, LEGACY_RUNNER_LOGS_ROOT, API_RUNNER_LOGS_ROOT];

  for (const root of roots) {
    const base = path.resolve(root, id);
    const target = path.resolve(base, rest);
    if (!target.startsWith(base)) continue; // traversal guard

    let finalPath = target;
    try {
      const st = fs.statSync(finalPath);
      if (st.isDirectory()) {
        finalPath = path.join(finalPath, "index.html");
      }
    } catch {
      continue;
    }

    try {
      const data = fs.readFileSync(finalPath);
      const ext = path.extname(finalPath).toLowerCase();
      const type =
        ext === ".html"
          ? "text/html"
          : ext === ".js"
          ? "application/javascript"
          : ext === ".css"
          ? "text/css"
          : ext === ".json"
          ? "application/json"
          : ext === ".svg"
          ? "image/svg+xml"
          : "application/octet-stream";
      reply.header("Content-Type", `${type}; charset=utf-8`);
      return reply.send(data);
    } catch {
      // try next root
    }
  }

  return reply.code(404).send("Not found");
});

if (AVAILABLE_RUNNER_ROOTS.length > 0) {
  app.get("/assets/*", async (req, reply) => {
    const splat = (req.params as any)["*"] as string | undefined;
    const rest = splat || "";
    const referer = (req.headers.referer || "").toString();
    const match = referer.match(/\/runner-logs\/([^/]+)\//);
    if (!match) {
      return reply.code(404).send("Not found");
    }
    const id = match[1];
    for (const root of AVAILABLE_RUNNER_ROOTS) {
      const base = path.resolve(root, id);
      const target = path.resolve(base, "allure-report", rest);
      if (!target.startsWith(base)) continue;
      try {
        const data = fs.readFileSync(target);
        const ext = path.extname(target).toLowerCase();
        const type =
          ext === ".html"
            ? "text/html"
            : ext === ".js"
            ? "application/javascript"
            : ext === ".css"
            ? "text/css"
            : ext === ".json"
            ? "application/json"
            : ext === ".svg"
            ? "image/svg+xml"
            : "application/octet-stream";
        reply.header("Content-Type", `${type}; charset=utf-8`);
        return reply.send(data);
      } catch (err) {
        continue;
      }
    }

    return reply.code(404).send("Not found");
  });
}

// Serve built web assets (SPA) when available
const WEB_DIST = path.join(REPO_ROOT, "apps", "web", "dist");
if (fs.existsSync(WEB_DIST)) {
  app.register(fastifyStatic, {
    root: WEB_DIST,
    prefix: "/", // serve assets at root
    decorateReply: false,
  });

  // SPA fallback for client routes (e.g., /reports) so refreshes work
  app.setNotFoundHandler((req, reply) => {
    const accept = req.headers.accept || "";
    if (req.method === "GET" && accept.includes("text/html")) {
      const indexPath = path.join(WEB_DIST, "index.html");
      if (fs.existsSync(indexPath)) {
        reply.type("text/html");
        return reply.send(fs.createReadStream(indexPath));
      }
    }
    return reply.code(404).send({ message: `Route ${req.method}:${req.url} not found`, error: "Not Found", statusCode: 404 });
  });
}

if (allowDebugRoutes) {
  app.get("/runner/debug/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const [db] = await prisma.$queryRawUnsafe<{ current_database: string }[]>(
      "select current_database()"
    );
    const proj = await prisma.project.findUnique({
      where: { id },
      select: { id: true, name: true, repoUrl: true, ownerId: true, createdAt: true },
    });
    return {
      currentDb: db?.current_database,
      project: proj,
      databaseUrl: (validatedEnv.DATABASE_URL || "").replace(/:\/\/.*@/, "://***@").split("?")[0],
    };
  });
  app.get("/debug/db-tables", async (req, reply) => {
    const { userId } = getAuth(req);
    if (!userId) return reply.code(401).send({ error: "Unauthorized" });
    const tables = await prisma.$queryRaw<
      { tablename: string }[]
    >`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename;`;

    return { count: tables.length, tables };
  });
}


app.get("/health", async () => ({ ok: true }));

// ---------- Schemas ----------
const optionalRepoUrl = z
  .string()
  .trim()
  .optional()
  .transform((v) => (v === "" ? undefined : v))
  .refine((v) => !v || z.string().url().safeParse(v).success, { message: "Enter a valid URL" });

const CreateProjectSchema = z.object({
  name: z.string().min(1, "Project name is required"),
  repoUrl: optionalRepoUrl,
});

const UpdateProjectSchema = z.object({
  name: z.string().min(1).optional(),
  repoUrl: optionalRepoUrl,
  sharedSteps: z.any().optional(),
});
type UpdateProjectBody = z.infer<typeof UpdateProjectSchema>;

const GLOBAL_NAV_KEY = "__global_nav__";

const SharedLocatorSchema = z.object({
  pagePath: z.string().min(1),
  bucket: z.enum(["fields", "buttons", "links", "locators"]),
  name: z.string().min(1),
  selector: z.string().min(1),
  projectId: z.string().optional(),
});
type SharedLocatorBody = z.infer<typeof SharedLocatorSchema>;

const LocatorSaveSchema = z.object({
  projectId: z.string().min(1),
  pagePath: z.string().optional(),
  urlPattern: z.string().optional(),
  bucket: z.enum(["fields", "buttons", "links", "locators"]).optional(),
  elementName: z.string().optional(),
  name: z.string().optional(),
  primary: z.string().min(1),
  fallbacks: z.array(z.string().min(1)).optional(),
  metadata: z.record(z.unknown()).optional(),
});
type LocatorSaveBody = z.infer<typeof LocatorSaveSchema>;

const normalizeLocatorPath = (pathValue: string) => {
  try {
    const url = new URL(pathValue, "http://localhost");
    const pathname = url.pathname || "/";
    const search = url.search || "";
    return `${pathname}${search}` || "/";
  } catch {
    return pathValue.startsWith("/") ? pathValue : `/${pathValue}`;
  }
};

// small guard you can reuse
function requireUser(req: any, reply: any) {
  const { userId } = getAuth(req);
  if (!userId) {
    reply.code(401).send({ error: "Unauthorized" });
    return null;
  }
  return userId;
}

// ---------- List ----------
app.get("/projects", async (req, reply) => {
  const userId = requireUser(req, reply);
  if (!userId) return;

  const projects = await prisma.project.findMany({
    where: { ownerId: userId },
    orderBy: { createdAt: "desc" },
  });

  return { projects };
});

// ---------- Read one ----------
app.get<{ Params: { id: string } }>("/projects/:id", async (req, reply) => {
  const userId = requireUser(req, reply);
  if (!userId) return;

  const { id } = req.params;
  const project = await prisma.project.findFirst({
    where: { id, ownerId: userId },
  });
  if (!project) return reply.code(404).send({ error: "Not found" });
  return { project };
});

// ---------- Create ----------
app.post("/projects", async (req, reply) => {
  const userId = requireUser(req, reply);
  if (!userId) return;

  const parsed = CreateProjectSchema.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: parsed.error.flatten() });
  }

  // ensure user row exists; rely on @default(free) for plan
  await prisma.user.upsert({
    where: { id: userId },
    update: {},
    create: { id: userId },
  });

  const { name, repoUrl } = parsed.data;
  const project = await prisma.project.create({
    data: { name, repoUrl: repoUrl ?? "", ownerId: userId },
  });

  return reply.code(201).send({ project });
});

// ---------- Update ----------
app.patch<{ Params: { id: string }; Body: UpdateProjectBody }>(
  "/projects/:id",
  async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;

    const parsed = UpdateProjectSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    const { id } = req.params;
    const existing = await prisma.project.findFirst({
      where: { id, ownerId: userId },
    });
    if (!existing) return reply.code(404).send({ error: "Not found" });

    const data: any = { ...parsed.data };
    if (parsed.data.repoUrl === undefined) {
      delete data.repoUrl;
    } else {
      data.repoUrl = parsed.data.repoUrl ?? "";
    }
    if (parsed.data.sharedSteps === undefined) {
      delete data.sharedSteps;
    } else {
      data.sharedSteps = parsed.data.sharedSteps;
    }

    const updated = await prisma.project.update({
      where: { id },
      data,
    });

    return { project: updated };
  }
);

app.post<{ Params: { id: string }; Body: SharedLocatorBody }>(
  "/projects/:id/shared-locators",
  async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;

    const parsed = SharedLocatorSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    const { id } = req.params;
    const project = await prisma.project.findFirst({
      where: { id, ownerId: userId },
      select: { id: true, sharedSteps: true },
    });
    if (!project) return reply.code(404).send({ error: "Project not found" });

    const { pagePath, bucket, name, selector } = parsed.data;
    const isGlobalNav = pagePath === GLOBAL_NAV_KEY;
    const normalizedPath = isGlobalNav ? GLOBAL_NAV_KEY : normalizeLocatorPath(pagePath);
    const sharedSteps = (project.sharedSteps ?? {}) as Record<string, any>;

    if (isGlobalNav) {
      const nav = { ...(sharedSteps.nav ?? {}) };
      nav[name] = selector;
      const now = new Date().toISOString();
      const nextSharedSteps = {
        ...sharedSteps,
        nav,
        locatorMeta: {
          ...(sharedSteps.locatorMeta ?? {}),
          updatedAt: now,
          updatedBy: userId,
        },
      };

      const updated = await prisma.project.update({
        where: { id },
        data: { sharedSteps: nextSharedSteps },
        select: { sharedSteps: true },
      });

      scheduleSpecRegeneration({
        projectId: id,
        userId,
        baseUrl: (sharedSteps as any)?.baseUrl,
        sharedSteps: nextSharedSteps,
      });

      return reply.send({ sharedSteps: updated.sharedSteps });
    }

    let pages: Record<string, any> = {};
    if (sharedSteps.pages && typeof sharedSteps.pages === "object") {
      pages = { ...sharedSteps.pages };
    } else if (sharedSteps.locators && typeof sharedSteps.locators === "object") {
      pages = Object.entries(sharedSteps.locators as Record<string, any>).reduce(
        (acc, [key, locators]) => {
          acc[key] = { locators: { ...(locators as Record<string, string>) } };
          return acc;
        },
        {} as Record<string, any>
      );
    }

    const page = { ...(pages[normalizedPath] ?? {}) };
    const bucketMap = { ...(page[bucket] ?? {}) };
    bucketMap[name] = selector;
    page[bucket] = bucketMap;
    pages[normalizedPath] = page;

    const now = new Date().toISOString();
    const nextSharedSteps = {
      ...sharedSteps,
      pages,
      locatorMeta: {
        ...(sharedSteps.locatorMeta ?? {}),
        updatedAt: now,
        updatedBy: userId,
      },
    };

    const updated = await prisma.project.update({
      where: { id },
      data: { sharedSteps: nextSharedSteps },
      select: { sharedSteps: true },
    });

    scheduleSpecRegeneration({
      projectId: id,
      userId,
      baseUrl: (sharedSteps as any)?.baseUrl,
      sharedSteps: nextSharedSteps,
    });

    return reply.send({ sharedSteps: updated.sharedSteps });
  }
);

app.post<{ Body: LocatorSaveBody }>("/locators", async (req, reply) => {
  const userId = requireUser(req, reply);
  if (!userId) return;

  const parsed = LocatorSaveSchema.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: parsed.error.flatten() });
  }

  const {
    projectId,
    pagePath,
    urlPattern,
    bucket: bucketInput,
    elementName,
    name: nameInput,
    primary,
    fallbacks,
    metadata,
  } = parsed.data;

  const name = (elementName || nameInput || "").trim();
  if (!name) return reply.code(400).send({ error: "elementName is required" });

  const project = await prisma.project.findFirst({
    where: { id: projectId, ownerId: userId },
    select: { id: true, sharedSteps: true },
  });
  if (!project) return reply.code(404).send({ error: "Project not found" });

  const bucket = bucketInput ?? "locators";
  const rawPath = pagePath || urlPattern || "/";
  const normalizedPath = normalizeLocatorPath(rawPath);
  const sharedSteps = (project.sharedSteps ?? {}) as Record<string, any>;

  let pages: Record<string, any> = {};
  if (sharedSteps.pages && typeof sharedSteps.pages === "object") {
    pages = { ...sharedSteps.pages };
  } else if (sharedSteps.locators && typeof sharedSteps.locators === "object") {
    pages = Object.entries(sharedSteps.locators as Record<string, any>).reduce(
      (acc, [key, locators]) => {
        acc[key] = { locators: { ...(locators as Record<string, string>) } };
        return acc;
      },
      {} as Record<string, any>
    );
  }

  const page = { ...(pages[normalizedPath] ?? {}) };
  const bucketMap = { ...(page[bucket] ?? {}) };
  bucketMap[name] = primary.trim();
  page[bucket] = bucketMap;
  pages[normalizedPath] = page;

  const cleanFallbacks = Array.from(
    new Set((fallbacks ?? []).map((v) => v.trim()).filter(Boolean))
  ).filter((value) => value !== primary.trim());

  const locatorFallbacks: Record<string, any> = {
    ...(sharedSteps.locatorFallbacks ?? {}),
  };
  const pageFallbacks = { ...(locatorFallbacks[normalizedPath] ?? {}) };
  const bucketFallbacks = { ...(pageFallbacks[bucket] ?? {}) };
  bucketFallbacks[name] = {
    primary: primary.trim(),
    fallbacks: cleanFallbacks,
    metadata,
    updatedBy: userId,
    updatedAt: new Date().toISOString(),
  };
  pageFallbacks[bucket] = bucketFallbacks;
  locatorFallbacks[normalizedPath] = pageFallbacks;

  const now = new Date().toISOString();
  const nextSharedSteps = {
    ...sharedSteps,
    pages,
    locatorFallbacks,
    locatorMeta: {
      ...(sharedSteps.locatorMeta ?? {}),
      updatedAt: now,
      updatedBy: userId,
    },
  };

  const updated = await prisma.project.update({
    where: { id: projectId },
    data: { sharedSteps: nextSharedSteps },
    select: { sharedSteps: true },
  });

  scheduleSpecRegeneration({
    projectId,
    userId,
    baseUrl: (sharedSteps as any)?.baseUrl,
    sharedSteps: nextSharedSteps,
  });

  return reply.send({ sharedSteps: updated.sharedSteps });
});

app.get<{ Params: { id: string } }>("/projects/:id/shared-locators", async (req, reply) => {
  const userId = requireUser(req, reply);
  if (!userId) return;

  const { id } = req.params;
  const project = await prisma.project.findFirst({
    where: { id, ownerId: userId },
    select: { id: true, sharedSteps: true },
  });
  if (!project) return reply.code(404).send({ error: "Project not found" });

  return reply.send({ sharedSteps: project.sharedSteps ?? {} });
});

// ---------- Delete ----------
app.delete<{ Params: { id: string } }>("/projects/:id", async (req, reply) => {
  const userId = requireUser(req, reply);
  if (!userId) return;

  const { id } = req.params;
  const existing = await prisma.project.findFirst({
    where: { id, ownerId: userId },
  });
  if (!existing) return reply.code(404).send({ error: "Not found" });

  await prisma.$transaction(async (tx) => {
    // Delete test results/healing attempts tied to this project
    await tx.testHealingAttempt.deleteMany({
      where: {
        OR: [
          { run: { projectId: id } },
          { testCase: { projectId: id } },
        ],
      },
    });
    await tx.testResult.deleteMany({
      where: { run: { projectId: id } },
    });
    await tx.testCase.deleteMany({ where: { projectId: id } });
    await tx.testSuite.deleteMany({ where: { projectId: id } });
    await tx.testRun.deleteMany({ where: { projectId: id } });

    // Delete agent data
    await tx.agentScenario.deleteMany({
      where: {
        OR: [
          { page: { session: { projectId: id } } },
          { attachedProjectId: id },
        ],
      },
    });
    await tx.agentPage.deleteMany({
      where: { session: { projectId: id } },
    });
    await tx.agentSession.deleteMany({ where: { projectId: id } });

    // Delete integrations/secrets
    await tx.projectSecret.deleteMany({ where: { projectId: id } });
    await tx.integration.deleteMany({ where: { projectId: id } });
    await tx.jiraIntegration.deleteMany({ where: { projectId: id } });

    // Finally delete the project
    await tx.project.delete({ where: { id } });
  });
  return reply.code(204).send();
});

// debug helpers
app.ready(() => {
  if (printRoutesEnabled) {
    console.log(app.printRoutes());
  }
});

// Start background workers when running the API (disable with START_WORKERS=false)
const startWorkersOnce = () => {
  if (globalState.__tmWorkersStarted) {
    app.log.info("[worker] already started; skipping duplicate init");
    return;
  }
  globalState.__tmWorkersStarted = true;

  if (!shouldStartWorkers) {
    app.log.info("[worker] START_WORKERS=false; skipping background workers");
    return;
  }

  const start = async (loader: Promise<any>, label: string) => {
    try {
      await loader;
      app.log.info(`[worker] ${label} started`);
    } catch (err) {
      app.log.error({ err }, `[worker] ${label} failed to start`);
    }
  };
  start(import("./runner/worker.js"), "test-runs");
  start(import("./runner/self-heal-worker.js"), "self-heal");
  start(import("./runner/security-worker.js"), "security-scan");
  start(import("./runner/allure-worker.js"), "allure-generate");
};

// Optional: auto-start local recorder helper (node recorder-helper.js) for in-app launch
const startRecorderHelper = (force = false) => {
  if (recorderState.__tmRecorderHelperStarted) return;
  if (!validatedEnv.START_RECORDER_HELPER && !force) {
    app.log.info("[recorder] START_RECORDER_HELPER=false; skipping auto-start");
    return;
  }
  if (disableRecorderRoutes) {
    app.log.info("[recorder] TM_DISABLE_RECORDER=1; skipping helper auto-start");
    return;
  }
  const helperPath = path.join(REPO_ROOT, "recorder-helper.js");
  if (!fs.existsSync(helperPath)) {
    app.log.warn(`[recorder] helper not found at ${helperPath}; skipping auto-start`);
    return;
  }
  try {
    recorderState.__tmRecorderHelperStarted = true;
    const child = spawn(process.execPath, [helperPath], {
      cwd: REPO_ROOT,
      stdio: "ignore",
      detached: true,
    });
    child.unref();
    app.log.info("[recorder] helper auto-started (detached)");
  } catch (err) {
    recorderState.__tmRecorderHelperStarted = false;
    app.log.error({ err }, "[recorder] failed to start helper");
  }
};

  app.addHook("onReady", async () => startRecorderHelper());

// Recorder helper status/start endpoints for UI "recheck" buttons
app.get("/recorder/helper/status", async () => {
  const helperUrl = process.env.RECORDER_HELPER || null;
  if (helperUrl) {
    try {
      const res = await fetch(`${helperUrl.replace(/\/$/, "")}/status`);
      if (!res.ok) throw new Error(`status ${res.status}`);
      return { started: true, configured: true, mode: "remote", helperUrl };
    } catch {
      return { started: false, configured: true, mode: "remote", helperUrl };
    }
  }

  return {
    started: !!recorderState.__tmRecorderHelperStarted,
    configured: !!validatedEnv.START_RECORDER_HELPER,
    mode: "local",
    helperUrl: null,
    helperPath: path.join(REPO_ROOT, "recorder-helper.js"),
  };
});

app.post("/recorder/helper/start", async () => {
  const helperUrl = process.env.RECORDER_HELPER || null;
  if (helperUrl) {
    try {
      const res = await fetch(`${helperUrl.replace(/\/$/, "")}/status`);
      return { started: res.ok, configured: true, mode: "remote", helperUrl };
    } catch {
      return { started: false, configured: true, mode: "remote", helperUrl };
    }
  }

  startRecorderHelper(true);
  return { started: !!recorderState.__tmRecorderHelperStarted, mode: "local", helperUrl: null };
});

if (allowDebugRoutes) {
  app.get("/runner/debug/list", async () => {
    return await prisma.project.findMany({
      select: { id: true, name: true, repoUrl: true, ownerId: true, createdAt: true },
      orderBy: { createdAt: "desc" },
      take: 10,
    });
  });

  app.post("/runner/seed-project", async (req, reply) => {
    const id = "cmgglhqyx0001z5n41vcvj9s1";
    const repoUrl = "https://github.com/farmerj50/coding-framework";
    const seeded = await prisma.project.upsert({
      where: { id },
      update: { repoUrl },
      create: { id, name: "justicpath", repoUrl, ownerId: "dev-seed" },
      select: { id: true, name: true, repoUrl: true, ownerId: true },
    });
    return { seeded };
  });
}

// --- Billing / Plan ---
app.get("/billing/me", async (req, reply) => {
  const userId = requireUser(req, reply);
  if (!userId) return;

  // ensure user exists; allow plan to be unset until selection
  const user = (await prisma.user.upsert({
    where: { id: userId },
    update: {},
    create: { id: userId },
    select: { id: true, plan: true, createdAt: true },
  })) as { id: string; plan: PlanTier | null; createdAt: Date };

  const plan = user.plan ?? null;
  return { plan, limits: plan ? getLimitsForPlan(plan) : null };
});

// Dev-only helper to switch plans
app.patch("/billing/me", async (req, reply) => {
  const userId = requireUser(req, reply);
  if (!userId) return;

  if (process.env.ALLOW_PLAN_PATCH !== "true") {
    return reply.code(403).send({ error: "Plan switching disabled" });
  }

  const allowed = ["free", "starter", "pro", "team"] as const;
  type Body = { plan?: (typeof allowed)[number] };

  const { plan } = (req.body ?? {}) as Body;
  if (!plan || !allowed.includes(plan)) {
    return reply.code(400).send({ error: "Invalid plan" });
  }

  const updated = await prisma.user.upsert({
    where: { id: userId },
    update: { plan },
    create: { id: userId, plan },
    select: { plan: true },
  });

  return { plan: updated.plan, limits: getLimitsForPlan(updated.plan) };
});

app.post("/billing/select", async (req, reply) => {
  const userId = requireUser(req, reply);
  if (!userId) return;

  const allowed = ["free"] as const;
  type Body = { plan?: (typeof allowed)[number] };
  const { plan } = (req.body ?? {}) as Body;
  if (!plan || !allowed.includes(plan)) {
    return reply.code(400).send({ error: "Invalid plan selection" });
  }

  const updated = await prisma.user.upsert({
    where: { id: userId },
    update: { plan },
    create: { id: userId, plan },
    select: { plan: true },
  });

  return { plan: updated.plan, limits: getLimitsForPlan(updated.plan) };
});

app.post("/billing/checkout", async (req, reply) => {
  const userId = requireUser(req, reply);
  if (!userId) return;

  const allowed = PAID_PLANS;
  type Body = { plan?: PaidPlan };
  const { plan } = (req.body ?? {}) as Body;
  if (!plan || !allowed.includes(plan)) {
    return reply.code(400).send({ error: "Invalid plan selection" });
  }

  await prisma.user.upsert({
    where: { id: userId },
    update: {},
    create: { id: userId },
    select: { id: true },
  });

  const stripe = requireStripe();
  const baseUrl = (validatedEnv.WEB_URL ?? "http://localhost:5173").replace(/\/$/, "");

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price: STRIPE_PRICE_IDS[plan], quantity: 1 }],
    client_reference_id: userId,
    metadata: { userId, plan },
    success_url: `${baseUrl}/pricing?checkout=success&plan=${plan}&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${baseUrl}/pricing?checkout=cancel&plan=${plan}`,
  });

  if (!session.url) {
    return reply.code(500).send({ error: "Stripe session missing URL" });
  }

  return { url: session.url };
});

app.post("/billing/confirm", async (req, reply) => {
  const userId = requireUser(req, reply);
  if (!userId) return;

  const body = (req.body ?? {}) as { sessionId?: string };
  const sessionId = body.sessionId?.trim();
  if (!sessionId) {
    return reply.code(400).send({ error: "Missing sessionId" });
  }

  const stripe = requireStripe();
  const session = await stripe.checkout.sessions.retrieve(sessionId);
  if (session.client_reference_id !== userId) {
    return reply.code(403).send({ error: "Session does not belong to user" });
  }

  const plan = (session.metadata?.plan ?? null) as PaidPlan | null;
  if (!plan || !PAID_PLANS.includes(plan)) {
    return reply.code(400).send({ error: "Invalid plan in session" });
  }

  if (session.status !== "complete") {
    return reply.code(400).send({ error: "Checkout not complete" });
  }

  const updated = await prisma.user.upsert({
    where: { id: userId },
    update: { plan },
    create: { id: userId, plan },
    select: { plan: true },
  });

  return { plan: updated.plan, limits: getLimitsForPlan(updated.plan) };
});
app.log.info(
  { PORT_env: process.env.PORT, validatedPort: validatedEnv.PORT, nodeEnv: validatedEnv.NODE_ENV },
  "[boot] port check"
);

console.log("[BOOT] reached bottom of index.ts BEFORE startServer()");


const startServer = async () => {
  console.log("[BOOT] inside startServer()");
  const port = getPlatformPort();
  console.log("[BOOT] chosen port =", port, "env.PORT =", process.env.PORT);

  app.log.info(
    {
      port,
      PORT_env: process.env.PORT,
      validatedPort: validatedEnv.PORT,
      nodeEnv: validatedEnv.NODE_ENV,
      tmSkipServer: validatedEnv.TM_SKIP_SERVER,
    },
    "[boot] starting server"
  );

  try {
    console.log("[BOOT] calling app.ready()");
    const heartbeat = setInterval(() => console.log("[BOOT] heartbeat"), 2000);
    heartbeat.unref();
    const establishTimeout = setTimeout(() => {
      console.error("[BOOT] app.ready() still pending after 15s");
      console.error("[BOOT] dumping active handles");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handles = (process as any)?._getActiveHandles?.() ?? [];
      console.error("[BOOT] active handles:", handles.map((h: any) => h?.constructor?.name));
      process.exit(1);
    }, 15_000);
    const readyTimeout: Promise<void> = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("app.ready() timed out after 10s")), 10_000)
    );
    await Promise.race([toVoidPromise(app.ready()), readyTimeout]);
    clearTimeout(establishTimeout);
    console.log("[BOOT] app.ready() resolved");

    const host = "::";
    if ((globalThis as any).__TM_LISTEN_CALLED__) {
      console.error("[BOOT] listen called twice – exiting");
      process.exit(1);
    }
    (globalThis as any).__TM_LISTEN_CALLED__ = true;
    console.log("[BOOT] about to listen", { host, port });
    const timeout: Promise<void> = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("listen() timed out after 10s")), 10_000)
    );
    await Promise.race([toVoidPromise(app.listen({ host, port })), timeout]);
    console.log("[BOOT] listen resolved OK");
    app.log.info({ port }, "[boot] API listening");
    startWorkersOnce();
    startRecorderHelper();
  } catch (err) {
    app.log.error({ err }, "[boot] Failed to start server");
    console.error("[BOOT] startServer failed", err);
    process.exit(1);
  }
};

startServer();
