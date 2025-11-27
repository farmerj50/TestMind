// apps/api/src/index.ts
import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { clerkPlugin, getAuth } from "@clerk/fastify";
import { z } from "zod";

import fastifyStatic from "@fastify/static";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

import { githubRoutes } from "./routes/github";
import { testRoutes } from "./routes/tests";
import runRoutes from "./routes/run";
import reportsRoutes from "./routes/reports";
import integrationsRoutes from "./routes/integrations";
import agentRoutes from "./routes/agent";
import jiraRoutes from "./routes/jira";
import { secretsRoutes } from "./routes/secrets";
import { prisma } from "./prisma";
import { validatedEnv } from "./config/env";
import recorderRoutes from "./routes/recorder";

// ✅ single source of truth for plan typing + limits
import { getLimitsForPlan } from "./config/plans";
import type { PlanTier } from "./config/plans";
import testmindRoutes from './testmind/routes';


const app = Fastify({ logger: true });
const REPO_ROOT = path.resolve(process.cwd());
const allowDebugRoutes = validatedEnv.NODE_ENV !== "production" || validatedEnv.ENABLE_DEBUG_ROUTES;
const allowedOrigins = validatedEnv.CORS_ORIGIN_LIST;
const shouldStartWorkers = validatedEnv.START_WORKERS;
const skipServer = validatedEnv.TM_SKIP_SERVER;
const globalState = globalThis as typeof globalThis & { __tmWorkersStarted?: boolean };
const recorderState = globalThis as typeof globalThis & { __tmRecorderHelperStarted?: boolean };

app.register(cors, {
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (allowedOrigins.some((allowed) => allowed === origin)) {
      return cb(null, true);
    }
    return cb(new Error("Not allowed"), false);
  },
  credentials: true,
});

app.register(clerkPlugin, {
  publishableKey: validatedEnv.CLERK_PUBLISHABLE_KEY,
  secretKey: validatedEnv.CLERK_SECRET_KEY,
});

app.register(githubRoutes);
app.register(testRoutes);
app.register(runRoutes, { prefix: "/runner" });
app.register(reportsRoutes, { prefix: "/" });
app.register(integrationsRoutes, { prefix: "/" });
app.register(agentRoutes, { prefix: "/" });
app.register(jiraRoutes, { prefix: "/" });
app.register(secretsRoutes, { prefix: "/" });
app.register(testmindRoutes, { prefix: "/tm" });
app.register(recorderRoutes, { prefix: "/" });
const PLAYWRIGHT_REPORT_ROOT = path.join(REPO_ROOT, "playwright-report");
if (fs.existsSync(PLAYWRIGHT_REPORT_ROOT)) {
  app.register(fastifyStatic, {
    root: PLAYWRIGHT_REPORT_ROOT,
    prefix: "/_static/playwright-report/",
  });
}
const RUNNER_LOGS_ROOT = path.join(REPO_ROOT, "runner-logs");
if (fs.existsSync(RUNNER_LOGS_ROOT)) {
  app.register(fastifyStatic, {
    root: RUNNER_LOGS_ROOT,
    prefix: "/_static/runner-logs/",
  });
}
const API_RUNNER_LOGS_ROOT = path.join(REPO_ROOT, "apps", "api", "runner-logs");
if (fs.existsSync(API_RUNNER_LOGS_ROOT)) {
  app.register(fastifyStatic, {
    root: API_RUNNER_LOGS_ROOT,
    prefix: "/_static/runner-logs/",
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
      return reply.sendFile("index.html");
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
}

app.get("/health", async () => ({ ok: true }));

// ---------- Schemas ----------
const CreateProjectSchema = z.object({
  name: z.string().min(1, "Project name is required"),
  repoUrl: z.string().url("Enter a valid URL"),
});

const UpdateProjectSchema = z.object({
  name: z.string().min(1).optional(),
  repoUrl: z.string().url().optional(),
});
type UpdateProjectBody = z.infer<typeof UpdateProjectSchema>;

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
    data: { name, repoUrl, ownerId: userId },
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

    const updated = await prisma.project.update({
      where: { id },
      data: parsed.data,
    });

    return { project: updated };
  }
);

// ---------- Delete ----------
app.delete<{ Params: { id: string } }>("/projects/:id", async (req, reply) => {
  const userId = requireUser(req, reply);
  if (!userId) return;

  const { id } = req.params;
  const existing = await prisma.project.findFirst({
    where: { id, ownerId: userId },
  });
  if (!existing) return reply.code(404).send({ error: "Not found" });

  await prisma.project.delete({ where: { id } });
  return reply.code(204).send();
});

// debug helpers
app.ready(() => {
  console.log(app.printRoutes());
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
  start(import("./runner/worker"), "test-runs");
  start(import("./runner/self-heal-worker"), "self-heal");
};

startWorkersOnce();

// Optional: auto-start local recorder helper (node recorder-helper.js) for in-app launch
const startRecorderHelper = () => {
  if (recorderState.__tmRecorderHelperStarted || !validatedEnv.START_RECORDER_HELPER) return;
  recorderState.__tmRecorderHelperStarted = true;
  const helperPath = path.join(REPO_ROOT, "recorder-helper.js");
  if (!fs.existsSync(helperPath)) {
    app.log.warn(`[recorder] helper not found at ${helperPath}; skipping auto-start`);
    return;
  }
  const child = spawn(process.execPath, [helperPath], {
    cwd: REPO_ROOT,
    stdio: "ignore",
    detached: true,
  });
  child.unref();
  app.log.info("[recorder] helper auto-started (detached)");
};

startRecorderHelper();

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

  // rely on DB default for plan; narrow shape for TS
  const user = (await prisma.user.upsert({
    where: { id: userId },
    update: {},
    create: { id: userId },
    select: { id: true, plan: true, createdAt: true },
  })) as { id: string; plan: PlanTier; createdAt: Date };

  return { plan: user.plan, limits: getLimitsForPlan(user.plan) };
});

// Dev-only helper to switch plans
app.patch("/billing/me", async (req, reply) => {
  const userId = requireUser(req, reply);
  if (!userId) return;

  if (process.env.ALLOW_PLAN_PATCH !== "true") {
    return reply.code(403).send({ error: "Plan switching disabled" });
  }

  const allowed = ["free", "pro", "enterprise"] as const;
  type Body = { plan?: (typeof allowed)[number] };

  const { plan } = (req.body ?? {}) as Body;
  if (!plan || !allowed.includes(plan)) {
    return reply.code(400).send({ error: "Invalid plan" });
  }

  const updated = await prisma.user.update({
    where: { id: userId },
    data: { plan },
    select: { plan: true },
  });

  return { plan: updated.plan, limits: getLimitsForPlan(updated.plan) };
});

const startServer = async () => {
  if (skipServer) {
    app.log.info("TM_SKIP_SERVER=true; skipping HTTP listener");
    return;
  }
  try {
    await app.listen({ host: "0.0.0.0", port: validatedEnv.PORT });
    app.log.info(`API listening on 0.0.0.0:${validatedEnv.PORT}`);
  } catch (err) {
    app.log.error({ err }, "Failed to start server");
    process.exit(1);
  }
};

startServer();
