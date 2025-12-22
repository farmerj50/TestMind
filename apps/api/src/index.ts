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

// ✅ single source of truth for plan typing + limits
import { getLimitsForPlan } from "./config/plans.js";
import type { PlanTier } from "./config/plans.js";
import testmindRoutes from './testmind/routes.js';
import type { FastifyCorsOptions } from "@fastify/cors";




const app = Fastify({ logger: true });
const REPO_ROOT = path.resolve(process.cwd(), "..", "..");


const raw = validatedEnv.CORS_ORIGINS.join(",");

const allowedOrigins = raw
  .split(",")
  .map((o) => o.trim().replace(/\/$/, ""))
  .filter(Boolean);

app.log.info(`[CORS] raw=${raw} allowed=${allowedOrigins.join(" | ") || "(empty)"}`);
process.on("unhandledRejection", (err) => {
  app.log.error({ err }, "[boot] unhandledRejection");
});

process.on("uncaughtException", (err) => {
  app.log.error({ err }, "[boot] uncaughtException");
  process.exit(1);
});



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

await app.register(cors, {
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);

    const normalized = origin.trim().replace(/\/$/, "");
    const ok = allowedOrigins.includes(normalized);

    // IMPORTANT: return boolean (not string) so fastify-cors handles headers consistently
    return cb(null, ok);
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "X-Requested-With",

    // ✅ Clerk commonly sends these (varies by SDK/version)
    "X-Clerk-Auth",
    "X-Clerk-Session",
    "X-Clerk-Client",
    "X-Clerk-Signature",
    "X-Clerk-Redirect-To",
  ],
  exposedHeaders: ["set-cookie"],
  optionsSuccessStatus: 204,
});


const shouldStartWorkers = validatedEnv.START_WORKERS;
// force server to always listen in production
//const skipServer = validatedEnv.NODE_ENV !== "production" && validatedEnv.TM_SKIP_SERVER;

const globalState = globalThis as typeof globalThis & { __tmWorkersStarted?: boolean };
const recorderState = globalThis as typeof globalThis & { __tmRecorderHelperStarted?: boolean };
const allowDebugRoutes =
  validatedEnv.NODE_ENV !== "production" || validatedEnv.ENABLE_DEBUG_ROUTES;


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
app.register(qaAgentRoutes, { prefix: "/" });
app.register(securityRoutes, { prefix: "/" });
app.register(testmindRoutes, { prefix: "/tm" });
app.register(recorderRoutes, { prefix: "/" });
const PLAYWRIGHT_REPORT_ROOT = path.join(REPO_ROOT, "playwright-report");
if (fs.existsSync(PLAYWRIGHT_REPORT_ROOT)) {
  app.register(fastifyStatic, {
    root: PLAYWRIGHT_REPORT_ROOT,
    prefix: "/_static/playwright-report/",
    decorateReply: false,
  });
}
const RUNNER_LOGS_ROOT = path.join(REPO_ROOT, "runner-logs");
const API_RUNNER_LOGS_ROOT = path.join(REPO_ROOT, "apps", "api", "runner-logs");
const AVAILABLE_RUNNER_ROOTS = [API_RUNNER_LOGS_ROOT, RUNNER_LOGS_ROOT].filter((candidate) => fs.existsSync(candidate));
const STATIC_RUNNER_ROOT = AVAILABLE_RUNNER_ROOTS[0] ?? null;
if (STATIC_RUNNER_ROOT) {
  app.register(fastifyStatic, {
    root: STATIC_RUNNER_ROOT,
    prefix: "/_static/runner-logs/",
    decorateReply: false,
  });
}

// Serve runner artifacts (e.g., allure) directly from either runner-logs root
app.get("/runner-logs/*", async (req, reply) => {
  const splat = (req.params as any)["*"] as string | undefined;
  const parts = (splat || "").split("/").filter(Boolean);
  const id = parts.shift();
  if (!id) return reply.code(404).send("Not found");
  const rest = parts.join("/");
  const roots = [path.join(REPO_ROOT, "runner-logs"), path.join(REPO_ROOT, "apps", "api", "runner-logs")];

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
}
app.get("/debug/db-tables", async () => {
  const tables = await prisma.$queryRaw<
    { tablename: string }[]
  >`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename;`;

  return { count: tables.length, tables };
});


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
  start(import("./runner/worker.js"), "test-runs");
  start(import("./runner/self-heal-worker.js"), "self-heal");
  start(import("./runner/security-worker.js"), "security-scan");
};

startWorkersOnce();

// Optional: auto-start local recorder helper (node recorder-helper.js) for in-app launch
const startRecorderHelper = () => {
  if (recorderState.__tmRecorderHelperStarted) return;
  if (!validatedEnv.START_RECORDER_HELPER) {
    app.log.info("[recorder] START_RECORDER_HELPER=false; skipping auto-start");
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

// start on bootstrap and after server is ready
startRecorderHelper();
app.addHook("onReady", async () => startRecorderHelper());

// Recorder helper status/start endpoints for UI "recheck" buttons
app.get("/recorder/helper/status", async () => ({
  started: !!recorderState.__tmRecorderHelperStarted,
  configured: !!validatedEnv.START_RECORDER_HELPER,
  helperPath: path.join(REPO_ROOT, "recorder-helper.js"),
}));

app.post("/recorder/helper/start", async () => {
  startRecorderHelper();
  return { started: !!recorderState.__tmRecorderHelperStarted };
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
app.log.info(
  { PORT_env: process.env.PORT, validatedPort: validatedEnv.PORT, nodeEnv: validatedEnv.NODE_ENV },
  "[boot] port check"
);


const startServer = async () => {
  // Railway injects PORT. Always prefer it.
  const port = Number(process.env.PORT ?? validatedEnv.PORT ?? 8787);

  app.log.info(
    { port, PORT_env: process.env.PORT, nodeEnv: validatedEnv.NODE_ENV, tmSkipServer: validatedEnv.TM_SKIP_SERVER },
    "[boot] starting server"
  );

  try {
    await app.listen({ host: "0.0.0.0", port });
    app.log.info(`API listening on 0.0.0.0:${port}`);
  } catch (err) {
    app.log.error({ err }, "Failed to start server");
    process.exit(1);
  }
};

startServer();

