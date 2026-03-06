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
import { createRequire } from "node:module";

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
import testBuilderRoutes from "./routes/testBuilder.js";
import { prisma } from "./prisma.js";
import { validatedEnv } from "./config/env.js";
import recorderRoutes from "./routes/recorder.js";
import { GENERATED_ROOT, REPORT_ROOT, ensureStorageDirs } from "./lib/storageRoots.js";
import { generateAndWrite } from "./testmind/service.js";
import { validateAndNormalizeRepoUrl } from "./lib/git-url.js";
import { safeFetch } from "./lib/safe-fetch.js";
import {
  scoreSelectorConfidence,
  type ConfidenceBreakdownItem,
} from "./lib/selector-confidence.js";

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
  const pathOnly = req.url.split("?")[0] || req.url;
  req.log.info(
    {
      method: req.method,
      url: pathOnly,
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
  const pathOnly = req.url.split("?")[0] || req.url;
  req.log.info(
    {
      method: req.method,
      url: pathOnly,
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
const isDevEnv = validatedEnv.NODE_ENV !== "production";

const isPrivateIpv4Host = (hostname: string) => {
  if (/^10\./.test(hostname)) return true;
  if (/^192\.168\./.test(hostname)) return true;
  const m = hostname.match(/^172\.(\d{1,3})\./);
  if (m) {
    const second = Number(m[1]);
    if (Number.isFinite(second) && second >= 16 && second <= 31) return true;
  }
  return false;
};

const isDevLocalOrigin = (origin: string) => {
  try {
    const u = new URL(origin);
    if (!/^https?:$/.test(u.protocol)) return false;
    const host = (u.hostname || "").toLowerCase();
    if (!host) return false;
    if (host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0" || host === "::1") {
      return true;
    }
    return isPrivateIpv4Host(host);
  } catch {
    return false;
  }
};

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
      const allowDevLocal = isDevEnv && isDevLocalOrigin(normalized);
      const ok = allowedOrigins.includes(normalized) || allowDevLocal;

      // DEBUG: log every origin decision
      app.log.info({ origin, normalized, ok, allowDevLocal }, "[CORS] check");

      cb(null, ok);
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "X-Requested-With",
      "X-Debug-Token",
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
const allowLocalRecorderHelper =
  validatedEnv.NODE_ENV !== "production" ||
  (process.env.TM_ALLOW_LOCAL_RECORDER_HELPER ?? "") === "1";
const printRoutesEnabled = (process.env.TM_PRINT_ROUTES ?? "").toLowerCase() === "1";
const debugToken = (process.env.DEBUG_TOKEN ?? "").trim();
const debugVolumeEnabled = !!debugToken;


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
await registerWithLog("testBuilderRoutes", () => app.register(testBuilderRoutes, { prefix: "/" }));
await registerWithLog("testmindRoutes", () => app.register(testmindRoutes, { prefix: "/tm" }));
console.log("[BOOT] TM_DISABLE_RECORDER =", process.env.TM_DISABLE_RECORDER);

const require = createRequire(import.meta.url);
try {
  console.log("[BOOT][dep] @playwright/test =", require.resolve("@playwright/test"));
} catch (err: any) {
  console.log("[BOOT][dep] @playwright/test NOT RESOLVABLE:", err?.message ?? err);
}
try {
  console.log("[BOOT][dep] playwright =", require.resolve("playwright"));
} catch (err: any) {
  console.log("[BOOT][dep] playwright NOT RESOLVABLE:", err?.message ?? err);
}
console.log("[BOOT][paths] TM_GENERATED_ROOT =", process.env.TM_GENERATED_ROOT ?? "");
console.log("[BOOT][paths] TM_REPORT_ROOT =", process.env.TM_REPORT_ROOT ?? "");
console.log("[BOOT][paths] TM_VOLUME_ROOT =", process.env.TM_VOLUME_ROOT ?? "");
console.log("[BOOT][paths] cwd =", process.cwd());
if (disableRecorderRoutes) {
  app.log.warn("[boot] recorderRoutes DISABLED via TM_DISABLE_RECORDER");
} else {
  await registerWithLog("recorderRoutes", () => app.register(recorderRoutes, { prefix: "/" }));
}

const assertDebugAuth = (req: { headers: Record<string, any> }, reply: { code: (status: number) => any }) => {
  if (!debugVolumeEnabled) {
    reply.code(404).send({ error: "Not found" });
    return false;
  }
  const token = (req.headers["x-debug-token"] as string | undefined) || "";
  if (!token || token !== debugToken) {
    reply.code(401).send({ error: "Unauthorized" });
    return false;
  }
  return true;
};

const resolveDebugPath = (rawPath?: string) => {
  const rel = (rawPath || "").toString().replace(/^\/+/, "");
  const base = path.resolve(GENERATED_ROOT);
  const abs = path.resolve(base, rel);
  if (!abs.startsWith(base)) {
    return { ok: false, base, abs };
  }
  return { ok: true, base, abs };
};

app.get("/debug/volume/ls", async (req, reply) => {
  if (!assertDebugAuth(req, reply)) return;
  const rawPath = (req.query as any)?.path as string | undefined;
  const resolved = resolveDebugPath(rawPath);
  if (!resolved.ok) {
    return reply.code(400).send({ error: "Bad path" });
  }
  if (!fs.existsSync(resolved.abs)) {
    return reply.code(404).send({ error: "Not found" });
  }
  const stat = fs.statSync(resolved.abs);
  if (!stat.isDirectory()) {
    return reply.code(400).send({ error: "Not a directory" });
  }
  const entries = fs.readdirSync(resolved.abs, { withFileTypes: true }).map((entry) => ({
    name: entry.name,
    type: entry.isDirectory() ? "dir" : "file",
  }));
  return reply.send({ volumeRoot: resolved.base, abs: resolved.abs, entries });
});

app.get("/debug/volume/read", async (req, reply) => {
  if (!assertDebugAuth(req, reply)) return;
  const rawPath = (req.query as any)?.path as string | undefined;
  const resolved = resolveDebugPath(rawPath);
  if (!resolved.ok) {
    return reply.code(400).send({ error: "Bad path" });
  }
  if (!fs.existsSync(resolved.abs)) {
    return reply.code(404).send({ error: "Not found" });
  }
  const stat = fs.statSync(resolved.abs);
  if (!stat.isFile()) {
    return reply.code(400).send({ error: "Not a file" });
  }
  const maxRaw = Number((req.query as any)?.max ?? 20000);
  const max = Number.isFinite(maxRaw) ? Math.min(Math.max(maxRaw, 0), 200000) : 20000;
  const data = fs.readFileSync(resolved.abs);
  return reply.send({
    volumeRoot: resolved.base,
    abs: resolved.abs,
    bytes: data.length,
    preview: data.toString("utf8", 0, max),
  });
});
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
  app.get("/debug/me", async (req, reply) => {
    const auth = getAuth(req);
    return reply.send({
      userId: auth.userId ?? null,
      sessionId: auth.sessionId ?? null,
      hasAuthHeader: Boolean(req.headers.authorization),
    });
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
app.get("/__whoami", async () => ({
  pid: process.pid,
  node: process.version,
  cwd: process.cwd(),
  stamp: new Date().toISOString(),
}));

// ---------- Schemas ----------
const optionalRepoUrl = z
  .string()
  .trim()
  .optional()
  .transform((v) => (v === "" ? undefined : v));

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
  suggestionOnly: z.boolean().optional(),
  confidence: z.number().min(0).max(100).optional(),
  sourcePath: z.string().optional(),
  href: z.string().optional(),
  label: z.string().optional(),
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

const PromoteNavSuggestionSchema = z.object({
  key: z.string().min(1),
  selector: z.string().optional(),
  removeAfterPromote: z.boolean().optional(),
});
type PromoteNavSuggestionBody = z.infer<typeof PromoteNavSuggestionSchema>;

const PromoteHighConfidenceNavSchema = z.object({
  minConfidence: z.number().min(0).max(100).optional(),
  removeAfterPromote: z.boolean().optional(),
  limit: z.number().int().min(1).max(500).optional(),
});
type PromoteHighConfidenceNavBody = z.infer<typeof PromoteHighConfidenceNavSchema>;

const PromoteHighConfidenceLocatorsSchema = z.object({
  minConfidence: z.number().min(0).max(100).optional(),
  limit: z.number().int().min(1).max(2000).optional(),
  overwriteExisting: z.boolean().optional(),
});
type PromoteHighConfidenceLocatorsBody = z.infer<typeof PromoteHighConfidenceLocatorsSchema>;

const LocatorHealthUpdateSchema = z.object({
  pagePath: z.string().min(1),
  bucket: z.enum(["fields", "buttons", "links", "locators"]),
  name: z.string().min(1),
  status: z.enum(["passed", "failed"]),
  selector: z.string().optional(),
  reason: z.string().optional(),
});
type LocatorHealthUpdateBody = z.infer<typeof LocatorHealthUpdateSchema>;

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

const TelemetryEventSchema = z.object({
  event: z.string().min(1).max(120),
  properties: z.record(z.any()).optional(),
});

type TelemetryRecord = {
  ts: string;
  event: string;
  userId: string;
  properties: Record<string, any>;
};

type NavSuggestionEntry = {
  selector: string;
  confidence?: number;
  confidenceBreakdown?: ConfidenceBreakdownItem[];
  sourcePath?: string;
  href?: string;
  label?: string;
  updatedAt: string;
  updatedBy: string;
};

const TELEMETRY_REDACT_KEYS = /(authorization|token|secret|password|cookie|api[-_]?key|session)/i;
const TELEMETRY_MAX_STRING = 500;
const TELEMETRY_MAX_DEPTH = 4;
const TELEMETRY_MAX_ARRAY = 50;
const TELEMETRY_MAX_KEYS = 100;

const truncateTelemetryString = (value: string) =>
  value.length > TELEMETRY_MAX_STRING ? `${value.slice(0, TELEMETRY_MAX_STRING)}...[truncated]` : value;

const sanitizeTelemetryValue = (value: unknown, depth = 0): unknown => {
  if (value == null) return value;
  if (typeof value === "string") return truncateTelemetryString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (depth >= TELEMETRY_MAX_DEPTH) return "[depth-limited]";
  if (Array.isArray(value)) {
    return value.slice(0, TELEMETRY_MAX_ARRAY).map((item) => sanitizeTelemetryValue(item, depth + 1));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    let count = 0;
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
      if (count >= TELEMETRY_MAX_KEYS) break;
      if (TELEMETRY_REDACT_KEYS.test(key)) {
        out[key] = "[redacted]";
      } else {
        out[key] = sanitizeTelemetryValue(raw, depth + 1);
      }
      count += 1;
    }
    return out;
  }
  return String(value);
};

const appendNavSuggestion = (
  sharedSteps: Record<string, any>,
  key: string,
  entry: Omit<NavSuggestionEntry, "updatedAt" | "updatedBy">,
  userId: string
) => {
  const now = new Date().toISOString();
  const existing = sharedSteps.navSuggestions && typeof sharedSteps.navSuggestions === "object"
    ? (sharedSteps.navSuggestions as Record<string, NavSuggestionEntry[]>)
    : {};
  const keyList = Array.isArray(existing[key]) ? [...existing[key]] : [];
  const deduped = keyList.filter((item) => item?.selector !== entry.selector);
  const computed =
    typeof entry.confidence === "number"
      ? {
          score: Math.max(0, Math.min(100, Math.round(entry.confidence))),
          breakdown: entry.confidenceBreakdown ?? [{ delta: 0, reason: "provided" }],
        }
      : scoreSelectorConfidence(entry.selector, {
          hasHref: !!entry.href,
          hasStableLabel: !!entry.label,
          hasStableRoleName: /role=|getbyrole/i.test(entry.selector),
        });
  const nextEntry: NavSuggestionEntry = {
    ...entry,
    confidence: computed.score,
    confidenceBreakdown: computed.breakdown,
    updatedAt: now,
    updatedBy: userId,
  };
  const nextList = [nextEntry, ...deduped]
    .sort((a, b) => {
      const scoreA = typeof a.confidence === "number" ? a.confidence : -1;
      const scoreB = typeof b.confidence === "number" ? b.confidence : -1;
      if (scoreA !== scoreB) return scoreB - scoreA;
      return (b.updatedAt || "").localeCompare(a.updatedAt || "");
    })
    .slice(0, 10);

  return {
    navSuggestions: {
      ...existing,
      [key]: nextList,
    },
    now,
  };
};

type LocatorHealthEntry = {
  pagePath: string;
  bucket: "fields" | "buttons" | "links" | "locators";
  name: string;
  selector?: string;
  successCount: number;
  failCount: number;
  lastPassedAt?: string;
  lastFailedAt?: string;
  lastFailureReason?: string;
  updatedAt: string;
  updatedBy: string;
};

const locatorHealthKey = (pagePath: string, bucket: string, name: string) =>
  `${pagePath}::${bucket}::${name}`;

const upsertLocatorHealth = (
  sharedSteps: Record<string, any>,
  update: LocatorHealthUpdateBody,
  userId: string
) => {
  const now = new Date().toISOString();
  const key = locatorHealthKey(update.pagePath, update.bucket, update.name);
  const existingMap =
    sharedSteps.locatorHealth && typeof sharedSteps.locatorHealth === "object"
      ? ({ ...(sharedSteps.locatorHealth as Record<string, LocatorHealthEntry>) } as Record<string, LocatorHealthEntry>)
      : ({} as Record<string, LocatorHealthEntry>);
  const prev = existingMap[key];
  const next: LocatorHealthEntry = {
    pagePath: update.pagePath,
    bucket: update.bucket,
    name: update.name,
    selector: update.selector ?? prev?.selector,
    successCount: Math.max(0, Number(prev?.successCount ?? 0)),
    failCount: Math.max(0, Number(prev?.failCount ?? 0)),
    lastPassedAt: prev?.lastPassedAt,
    lastFailedAt: prev?.lastFailedAt,
    lastFailureReason: prev?.lastFailureReason,
    updatedAt: now,
    updatedBy: userId,
  };
  if (update.status === "passed") {
    next.successCount += 1;
    next.lastPassedAt = now;
  } else {
    next.failCount += 1;
    next.lastFailedAt = now;
    next.lastFailureReason = update.reason?.trim() || prev?.lastFailureReason;
  }
  existingMap[key] = next;
  return { locatorHealth: existingMap, updatedAt: now };
};

const checkRecorderHelperStatus = async (helperUrl: string) => {
  const normalized = helperUrl.replace(/\/$/, "");
  const parsed = new URL(normalized);
  const isLocalHost =
    parsed.hostname === "localhost" ||
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "::1" ||
    parsed.hostname === "0.0.0.0";
  const res = await safeFetch(`${normalized}/status`, undefined, {
    allowHttp: isLocalHost,
    allowedHosts: [parsed.hostname],
    allowPrivateHosts: isLocalHost,
  });
  return res.ok;
};

const TELEMETRY_BUFFER_LIMIT = Number(process.env.TM_TELEMETRY_BUFFER_LIMIT ?? "500");
const telemetryBuffer: TelemetryRecord[] = [];

const appendTelemetryRecord = (record: TelemetryRecord) => {
  telemetryBuffer.push(record);
  const max = Number.isFinite(TELEMETRY_BUFFER_LIMIT) && TELEMETRY_BUFFER_LIMIT > 0
    ? Math.trunc(TELEMETRY_BUFFER_LIMIT)
    : 500;
  if (telemetryBuffer.length > max) {
    telemetryBuffer.splice(0, telemetryBuffer.length - max);
  }
};

app.post("/telemetry/events", async (req, reply) => {
  const userId = requireUser(req, reply);
  if (!userId) return;

  const parsed = TelemetryEventSchema.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: parsed.error.flatten() });
  }

  const { event } = parsed.data;
  const sanitizedProperties = sanitizeTelemetryValue(parsed.data.properties ?? {}) as Record<string, any>;
  appendTelemetryRecord({
    ts: new Date().toISOString(),
    event,
    userId,
    properties: sanitizedProperties,
  });
  req.log.info(
    {
      telemetry: {
        event,
        userId,
        properties: sanitizedProperties,
      },
    },
    "[telemetry] event"
  );
  return reply.send({ ok: true });
});

app.get("/telemetry/events/recent", async (req, reply) => {
  const userId = requireUser(req, reply);
  if (!userId) return;

  const limitRaw = Number((req.query as any)?.limit);
  const limit = Number.isFinite(limitRaw)
    ? Math.min(Math.max(Math.trunc(limitRaw), 1), 200)
    : 50;

  const events = telemetryBuffer
    .filter((record) => record.userId === userId)
    .slice(-limit)
    .reverse();

  return reply.send({ events });
});

// ---------- Auth bootstrap (create user on first login) ----------
app.post("/auth/bootstrap", async (req, reply) => {
  const userId = requireUser(req, reply);
  if (!userId) return;
  let existing = await prisma.user.findUnique({ where: { id: userId } });
  if (!existing) {
    existing = await prisma.user.create({ data: { id: userId, plan: "free" } });
  } else if (!existing.plan) {
    existing = await prisma.user.update({
      where: { id: userId },
      data: { plan: "free" },
    });
  }

  const ageMs = existing?.createdAt ? Date.now() - new Date(existing.createdAt).getTime() : 0;
  const recentThresholdMs = 10 * 60 * 1000; // 10 minutes
  const projectCount = await prisma.project.count({ where: { ownerId: userId } });
  const isNew = ageMs >= 0 && ageMs < recentThresholdMs && projectCount === 0;

  if (isNew) {
    // Defensive cleanup: ensure no stale GitHub token is associated with a brand-new user
    await prisma.gitAccount.deleteMany({ where: { provider: "github", userId } });
  }

  return reply.send({ isNew });
});

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
    create: { id: userId, plan: "free" },
  });

  const { name, repoUrl } = parsed.data;
  let normalizedRepoUrl = "";
  if (repoUrl) {
    const checked = validateAndNormalizeRepoUrl(repoUrl);
    if (!checked.ok) {
      const reason = "reason" in checked ? checked.reason : "Invalid repository URL";
      return reply.code(400).send({ error: reason });
    }
    normalizedRepoUrl = checked.normalized;
  }
  const project = await prisma.project.create({
    data: { name, repoUrl: normalizedRepoUrl, ownerId: userId },
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
      if (!parsed.data.repoUrl) {
        data.repoUrl = "";
      } else {
        const checked = validateAndNormalizeRepoUrl(parsed.data.repoUrl);
        if (!checked.ok) {
          const reason = "reason" in checked ? checked.reason : "Invalid repository URL";
          return reply.code(400).send({ error: reason });
        }
        data.repoUrl = checked.normalized;
      }
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

    const { pagePath, bucket, name, selector, suggestionOnly, confidence, sourcePath, href, label } = parsed.data;
    const isGlobalNav = pagePath === GLOBAL_NAV_KEY;
    const normalizedPath = isGlobalNav ? GLOBAL_NAV_KEY : normalizeLocatorPath(pagePath);
    const sharedSteps = (project.sharedSteps ?? {}) as Record<string, any>;

    if (isGlobalNav) {
      if (suggestionOnly) {
        const navSuggestionState = appendNavSuggestion(
          sharedSteps,
          name,
          { selector, confidence, sourcePath, href, label },
          userId
        );
        const nextSharedSteps = {
          ...sharedSteps,
          navSuggestions: navSuggestionState.navSuggestions,
          locatorMeta: {
            ...(sharedSteps.locatorMeta ?? {}),
            updatedAt: navSuggestionState.now,
            updatedBy: userId,
          },
        };

        const updated = await prisma.project.update({
          where: { id },
          data: { sharedSteps: nextSharedSteps },
          select: { sharedSteps: true },
        });
        return reply.send({ sharedSteps: updated.sharedSteps });
      }

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
  const primaryConfidence = scoreSelectorConfidence(primary.trim());
  const fallbackConfidence = cleanFallbacks.map((value) => ({
    selector: value,
    ...scoreSelectorConfidence(value),
  }));

  const locatorFallbacks: Record<string, any> = {
    ...(sharedSteps.locatorFallbacks ?? {}),
  };
  const pageFallbacks = { ...(locatorFallbacks[normalizedPath] ?? {}) };
  const bucketFallbacks = { ...(pageFallbacks[bucket] ?? {}) };
  bucketFallbacks[name] = {
    primary: primary.trim(),
    fallbacks: cleanFallbacks,
    metadata: {
      ...(metadata ?? {}),
      confidenceScore: primaryConfidence.score,
      confidenceBreakdown: primaryConfidence.breakdown,
      fallbackConfidence,
    },
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

app.get<{ Params: { id: string } }>("/projects/:id/nav-suggestions", async (req, reply) => {
  const userId = requireUser(req, reply);
  if (!userId) return;

  const { id } = req.params;
  const project = await prisma.project.findFirst({
    where: { id, ownerId: userId },
    select: { id: true, sharedSteps: true },
  });
  if (!project) return reply.code(404).send({ error: "Project not found" });

  const sharedSteps = (project.sharedSteps ?? {}) as Record<string, any>;
  const navSuggestions =
    sharedSteps.navSuggestions && typeof sharedSteps.navSuggestions === "object"
      ? sharedSteps.navSuggestions
      : {};
  return reply.send({ navSuggestions });
});

app.post<{ Params: { id: string }; Body: PromoteNavSuggestionBody }>(
  "/projects/:id/nav-suggestions/promote",
  async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;

    const parsed = PromoteNavSuggestionSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    const { id } = req.params;
    const project = await prisma.project.findFirst({
      where: { id, ownerId: userId },
      select: { id: true, sharedSteps: true },
    });
    if (!project) return reply.code(404).send({ error: "Project not found" });

    const { key, selector, removeAfterPromote } = parsed.data;
    const sharedSteps = (project.sharedSteps ?? {}) as Record<string, any>;
    const navSuggestions =
      sharedSteps.navSuggestions && typeof sharedSteps.navSuggestions === "object"
        ? ({ ...(sharedSteps.navSuggestions as Record<string, NavSuggestionEntry[]>) } as Record<string, NavSuggestionEntry[]>)
        : {};
    const candidates = Array.isArray(navSuggestions[key]) ? navSuggestions[key] : [];
    if (!candidates.length) {
      return reply.code(404).send({ error: "No nav suggestions found for key" });
    }

    const selected =
      (selector ? candidates.find((item) => item.selector === selector) : undefined) ??
      candidates[0];
    if (!selected?.selector) {
      return reply.code(404).send({ error: "No matching selector to promote" });
    }

    const nav = { ...(sharedSteps.nav ?? {}) };
    nav[key] = selected.selector;

    const shouldRemove = removeAfterPromote ?? true;
    if (shouldRemove) {
      navSuggestions[key] = candidates.filter((item) => item.selector !== selected.selector);
      if (!navSuggestions[key].length) delete navSuggestions[key];
    }

    const now = new Date().toISOString();
    const nextSharedSteps = {
      ...sharedSteps,
      nav,
      navSuggestions,
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

    appendTelemetryRecord({
      ts: now,
      event: "nav_suggestion_promoted",
      userId,
      properties: {
        projectId: id,
        key,
        selector: selected.selector,
        confidence: typeof selected.confidence === "number" ? selected.confidence : null,
        removeAfterPromote: shouldRemove,
      },
    });

    scheduleSpecRegeneration({
      projectId: id,
      userId,
      baseUrl: (sharedSteps as any)?.baseUrl,
      sharedSteps: nextSharedSteps,
    });

    return reply.send({
      promoted: { key, selector: selected.selector },
      navSuggestions,
      sharedSteps: updated.sharedSteps,
    });
  }
);

app.post<{ Params: { id: string }; Body: PromoteHighConfidenceNavBody }>(
  "/projects/:id/nav-suggestions/promote-high-confidence",
  async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;

    const parsed = PromoteHighConfidenceNavSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    const { id } = req.params;
    const project = await prisma.project.findFirst({
      where: { id, ownerId: userId },
      select: { id: true, sharedSteps: true },
    });
    if (!project) return reply.code(404).send({ error: "Project not found" });

    const minConfidence = parsed.data.minConfidence ?? 75;
    const removeAfterPromote = parsed.data.removeAfterPromote ?? true;
    const limit = parsed.data.limit ?? 100;

    const sharedSteps = (project.sharedSteps ?? {}) as Record<string, any>;
    const nav = { ...(sharedSteps.nav ?? {}) };
    const navSuggestions =
      sharedSteps.navSuggestions && typeof sharedSteps.navSuggestions === "object"
        ? ({ ...(sharedSteps.navSuggestions as Record<string, any[]>) } as Record<string, any[]>)
        : {};

    const promoted: Array<{ key: string; selector: string; confidence: number | null }> = [];

    for (const [key, entriesRaw] of Object.entries(navSuggestions)) {
      if (promoted.length >= limit) break;
      const entries = Array.isArray(entriesRaw) ? entriesRaw : [];
      if (!entries.length) continue;
      const sorted = [...entries].sort((a: any, b: any) => {
        const scoreA = typeof a?.confidence === "number" ? a.confidence : -1;
        const scoreB = typeof b?.confidence === "number" ? b.confidence : -1;
        if (scoreA !== scoreB) return scoreB - scoreA;
        return String(b?.updatedAt ?? "").localeCompare(String(a?.updatedAt ?? ""));
      });
      const pick = sorted.find((entry: any) => {
        const score = typeof entry?.confidence === "number" ? entry.confidence : 0;
        return score >= minConfidence && typeof entry?.selector === "string" && entry.selector.trim().length > 0;
      });
      if (!pick) continue;
      nav[key] = pick.selector;
      promoted.push({
        key,
        selector: pick.selector,
        confidence: typeof pick.confidence === "number" ? pick.confidence : null,
      });

      if (removeAfterPromote) {
        const remaining = entries.filter((entry: any) => entry?.selector !== pick.selector);
        if (remaining.length) navSuggestions[key] = remaining;
        else delete navSuggestions[key];
      }
    }

    const now = new Date().toISOString();
    const nextSharedSteps = {
      ...sharedSteps,
      nav,
      navSuggestions,
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

    appendTelemetryRecord({
      ts: now,
      event: "nav_promote_high_confidence",
      userId,
      properties: {
        projectId: id,
        promotedCount: promoted.length,
        minConfidence,
        removeAfterPromote,
        limit,
      },
    });

    scheduleSpecRegeneration({
      projectId: id,
      userId,
      baseUrl: (sharedSteps as any)?.baseUrl,
      sharedSteps: nextSharedSteps,
    });

    return reply.send({
      promotedCount: promoted.length,
      promoted,
      filters: { minConfidence, removeAfterPromote, limit },
      sharedSteps: updated.sharedSteps,
    });
  }
);

app.post<{ Params: { id: string }; Body: PromoteHighConfidenceLocatorsBody }>(
  "/projects/:id/locators/promote-high-confidence",
  async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;

    const parsed = PromoteHighConfidenceLocatorsSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    const { id } = req.params;
    const project = await prisma.project.findFirst({
      where: { id, ownerId: userId },
      select: { id: true, sharedSteps: true },
    });
    if (!project) return reply.code(404).send({ error: "Project not found" });

    const minConfidence = parsed.data.minConfidence ?? 75;
    const limit = parsed.data.limit ?? 300;
    const overwriteExisting = parsed.data.overwriteExisting ?? false;

    const sharedSteps = (project.sharedSteps ?? {}) as Record<string, any>;
    const locatorFallbacks =
      sharedSteps.locatorFallbacks && typeof sharedSteps.locatorFallbacks === "object"
        ? (sharedSteps.locatorFallbacks as Record<string, any>)
        : {};

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

    const promoted: Array<{
      pagePath: string;
      bucket: "fields" | "buttons" | "links" | "locators";
      name: string;
      selector: string;
      confidence: number | null;
    }> = [];

    const bucketNames: Array<"fields" | "buttons" | "links" | "locators"> = ["fields", "buttons", "links", "locators"];

    for (const [pagePath, fallbackPageRaw] of Object.entries(locatorFallbacks)) {
      if (promoted.length >= limit) break;
      if (!fallbackPageRaw || typeof fallbackPageRaw !== "object") continue;
      const fallbackPage = fallbackPageRaw as Record<string, any>;
      const page = { ...(pages[pagePath] ?? {}) };

      for (const bucket of bucketNames) {
        if (promoted.length >= limit) break;
        const fallbackBucket =
          fallbackPage[bucket] && typeof fallbackPage[bucket] === "object"
            ? (fallbackPage[bucket] as Record<string, any>)
            : {};
        const pageBucket = { ...(page[bucket] ?? {}) };

        for (const [name, fallbackEntryRaw] of Object.entries(fallbackBucket)) {
          if (promoted.length >= limit) break;
          if (!fallbackEntryRaw || typeof fallbackEntryRaw !== "object") continue;
          const fallbackEntry = fallbackEntryRaw as Record<string, any>;
          const selector =
            typeof fallbackEntry.primary === "string" && fallbackEntry.primary.trim()
              ? fallbackEntry.primary.trim()
              : "";
          if (!selector) continue;

          const confidenceValue = Number(fallbackEntry?.metadata?.confidenceScore);
          const confidence = Number.isFinite(confidenceValue) ? confidenceValue : null;
          if ((confidence ?? 0) < minConfidence) continue;

          const hasExisting = typeof pageBucket[name] === "string" && pageBucket[name].trim().length > 0;
          if (hasExisting && !overwriteExisting) continue;

          pageBucket[name] = selector;
          promoted.push({
            pagePath,
            bucket,
            name,
            selector,
            confidence,
          });
        }

        page[bucket] = pageBucket;
      }

      pages[pagePath] = page;
    }

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

    appendTelemetryRecord({
      ts: now,
      event: "locator_promote_high_confidence",
      userId,
      properties: {
        projectId: id,
        promotedCount: promoted.length,
        minConfidence,
        limit,
        overwriteExisting,
      },
    });

    scheduleSpecRegeneration({
      projectId: id,
      userId,
      baseUrl: (sharedSteps as any)?.baseUrl,
      sharedSteps: nextSharedSteps,
    });

    return reply.send({
      promotedCount: promoted.length,
      promoted,
      filters: { minConfidence, limit, overwriteExisting },
      sharedSteps: updated.sharedSteps,
    });
  }
);

app.get<{ Params: { id: string } }>("/projects/:id/locator-health", async (req, reply) => {
  const userId = requireUser(req, reply);
  if (!userId) return;

  const { id } = req.params;
  const project = await prisma.project.findFirst({
    where: { id, ownerId: userId },
    select: { id: true, sharedSteps: true },
  });
  if (!project) return reply.code(404).send({ error: "Project not found" });

  const sharedSteps = (project.sharedSteps ?? {}) as Record<string, any>;
  const locatorHealth =
    sharedSteps.locatorHealth && typeof sharedSteps.locatorHealth === "object"
      ? sharedSteps.locatorHealth
      : {};
  return reply.send({ locatorHealth });
});

app.get<{ Params: { id: string } }>("/projects/:id/locator-health/weak", async (req, reply) => {
  const userId = requireUser(req, reply);
  if (!userId) return;

  const { id } = req.params;
  const project = await prisma.project.findFirst({
    where: { id, ownerId: userId },
    select: { id: true, sharedSteps: true },
  });
  if (!project) return reply.code(404).send({ error: "Project not found" });

  const sharedSteps = (project.sharedSteps ?? {}) as Record<string, any>;
  const locatorHealthRaw =
    sharedSteps.locatorHealth && typeof sharedSteps.locatorHealth === "object"
      ? (sharedSteps.locatorHealth as Record<string, any>)
      : {};

  const limitRaw = Number((req.query as any)?.limit);
  const minSamplesRaw = Number((req.query as any)?.minSamples);
  const minFailRateRaw = Number((req.query as any)?.minFailRate);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.trunc(limitRaw), 1), 200) : 25;
  const minSamples = Number.isFinite(minSamplesRaw) ? Math.max(Math.trunc(minSamplesRaw), 1) : 2;
  const minFailRate = Number.isFinite(minFailRateRaw) ? Math.max(0, Math.min(1, minFailRateRaw)) : 0.5;

  const weak = Object.values(locatorHealthRaw)
    .map((entry: any) => {
      const successCount = Math.max(0, Number(entry?.successCount ?? 0));
      const failCount = Math.max(0, Number(entry?.failCount ?? 0));
      const total = successCount + failCount;
      const failRate = total > 0 ? failCount / total : 0;
      return {
        ...entry,
        successCount,
        failCount,
        total,
        failRate,
      };
    })
    .filter((entry: any) => entry.total >= minSamples && entry.failRate >= minFailRate)
    .sort((a: any, b: any) => {
      if (b.failRate !== a.failRate) return b.failRate - a.failRate;
      if (b.failCount !== a.failCount) return b.failCount - a.failCount;
      return String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? ""));
    })
    .slice(0, limit);

  return reply.send({
    weakLocators: weak,
    filters: { limit, minSamples, minFailRate },
  });
});

app.post<{ Params: { id: string }; Body: LocatorHealthUpdateBody }>(
  "/projects/:id/locator-health",
  async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;

    const parsed = LocatorHealthUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    const { id } = req.params;
    const project = await prisma.project.findFirst({
      where: { id, ownerId: userId },
      select: { id: true, sharedSteps: true },
    });
    if (!project) return reply.code(404).send({ error: "Project not found" });

    const sharedSteps = (project.sharedSteps ?? {}) as Record<string, any>;
    const nextHealth = upsertLocatorHealth(sharedSteps, parsed.data, userId);
    const nextSharedSteps = {
      ...sharedSteps,
      locatorHealth: nextHealth.locatorHealth,
      locatorMeta: {
        ...(sharedSteps.locatorMeta ?? {}),
        updatedAt: nextHealth.updatedAt,
        updatedBy: userId,
      },
    };

    const updated = await prisma.project.update({
      where: { id },
      data: { sharedSteps: nextSharedSteps },
      select: { sharedSteps: true },
    });
    return reply.send({ locatorHealth: nextSharedSteps.locatorHealth, sharedSteps: updated.sharedSteps });
  }
);

app.get<{ Params: { id: string } }>("/projects/:id/quality-metrics", async (req, reply) => {
  const userId = requireUser(req, reply);
  if (!userId) return;

  const { id } = req.params;
  const project = await prisma.project.findFirst({
    where: { id, ownerId: userId },
    select: { id: true, sharedSteps: true },
  });
  if (!project) return reply.code(404).send({ error: "Project not found" });

  const daysRaw = Number((req.query as any)?.days);
  const days = Number.isFinite(daysRaw) ? Math.min(Math.max(Math.trunc(daysRaw), 1), 90) : 14;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const [healingAttempts, selfHealReruns, parentRuns] = await Promise.all([
    prisma.testHealingAttempt.findMany({
      where: { run: { projectId: id }, createdAt: { gte: since } },
      select: { id: true, status: true, runId: true, createdAt: true },
    }),
    prisma.testRun.findMany({
      where: { projectId: id, rerunOfId: { not: null }, trigger: "self-heal", createdAt: { gte: since } },
      select: { id: true, rerunOfId: true, status: true, createdAt: true, finishedAt: true },
    }),
    prisma.testRun.findMany({
      where: { projectId: id, createdAt: { gte: since }, status: "failed" },
      select: { id: true, createdAt: true },
    }),
  ]);

  const healingTotal = healingAttempts.length;
  const healingSucceeded = healingAttempts.filter((x) => x.status === "succeeded").length;
  const llmPatchSuccessRate = healingTotal > 0 ? healingSucceeded / healingTotal : null;

  const rerunTotal = selfHealReruns.length;
  const rerunSucceeded = selfHealReruns.filter((x) => x.status === "succeeded").length;
  const selfHealRerunPassRate = rerunTotal > 0 ? rerunSucceeded / rerunTotal : null;

  const firstRerunByParent = new Map<string, { status: string; createdAt: Date; finishedAt: Date | null }>();
  for (const rerun of selfHealReruns) {
    const parentId = rerun.rerunOfId as string | null;
    if (!parentId) continue;
    const prev = firstRerunByParent.get(parentId);
    if (!prev || rerun.createdAt < prev.createdAt) {
      firstRerunByParent.set(parentId, {
        status: rerun.status,
        createdAt: rerun.createdAt,
        finishedAt: rerun.finishedAt,
      });
    }
  }
  const firstRerunTotal = firstRerunByParent.size;
  const firstRerunPassed = Array.from(firstRerunByParent.values()).filter((x) => x.status === "succeeded").length;
  const firstRerunPassRate = firstRerunTotal > 0 ? firstRerunPassed / firstRerunTotal : null;

  const parentById = new Map(parentRuns.map((r) => [r.id, r]));
  const timeToGreenMinutes: number[] = [];
  for (const rerun of selfHealReruns) {
    if (rerun.status !== "succeeded") continue;
    const parentId = rerun.rerunOfId as string | null;
    if (!parentId) continue;
    const parent = parentById.get(parentId);
    if (!parent) continue;
    const diffMs = rerun.createdAt.getTime() - parent.createdAt.getTime();
    if (diffMs >= 0) timeToGreenMinutes.push(diffMs / (60 * 1000));
  }
  const meanTimeToGreenMinutes =
    timeToGreenMinutes.length > 0
      ? timeToGreenMinutes.reduce((acc, n) => acc + n, 0) / timeToGreenMinutes.length
      : null;

  const sharedSteps = (project.sharedSteps ?? {}) as Record<string, any>;
  const locatorHealthRaw =
    sharedSteps.locatorHealth && typeof sharedSteps.locatorHealth === "object"
      ? (sharedSteps.locatorHealth as Record<string, any>)
      : {};
  const weakLocatorCount = Object.values(locatorHealthRaw).filter((entry: any) => {
    const successCount = Math.max(0, Number(entry?.successCount ?? 0));
    const failCount = Math.max(0, Number(entry?.failCount ?? 0));
    const total = successCount + failCount;
    if (total < 2) return false;
    return failCount / total >= 0.5;
  }).length;

  const sinceMs = since.getTime();
  const recentTelemetry = telemetryBuffer.filter((record) => {
    if (record.userId !== userId) return false;
    const ts = Date.parse(record.ts);
    if (!Number.isFinite(ts) || ts < sinceMs) return false;
    return record.properties?.projectId === id;
  });
  const navPromotionActions = recentTelemetry.filter(
    (record) => record.event === "nav_suggestion_promoted" || record.event === "nav_promote_high_confidence"
  );
  const locatorPromotionActions = recentTelemetry.filter(
    (record) => record.event === "locator_promoted" || record.event === "locator_promote_all" || record.event === "locator_promote_high_confidence"
  );
  const navPromotionWithChanges = navPromotionActions.filter((record) => {
    if (record.event === "nav_suggestion_promoted") return true;
    const promotedCount = Number(record.properties?.promotedCount ?? 0);
    return Number.isFinite(promotedCount) && promotedCount > 0;
  }).length;
  const locatorPromotionWithChanges = locatorPromotionActions.filter((record) => {
    if (record.event === "locator_promoted") return true;
    if (record.event === "locator_promote_all") {
      const saved = Number(record.properties?.saved ?? 0);
      return Number.isFinite(saved) && saved > 0;
    }
    const promotedCount = Number(record.properties?.promotedCount ?? 0);
    return Number.isFinite(promotedCount) && promotedCount > 0;
  }).length;
  const navPromotionYieldRate =
    navPromotionActions.length > 0 ? navPromotionWithChanges / navPromotionActions.length : null;
  const locatorPromotionYieldRate =
    locatorPromotionActions.length > 0 ? locatorPromotionWithChanges / locatorPromotionActions.length : null;

  const dayKey = (dateValue: Date | string | number) => new Date(dateValue).toISOString().slice(0, 10);
  const trendDays = Math.min(days, 30);
  const trendStart = new Date(Date.now() - (trendDays - 1) * 24 * 60 * 60 * 1000);
  const trendByDay = new Map<
    string,
    {
      llmTotal: number;
      llmSucceeded: number;
      rerunTotal: number;
      rerunSucceeded: number;
      navActions: number;
      navChanges: number;
      locatorActions: number;
      locatorChanges: number;
    }
  >();
  for (let i = 0; i < trendDays; i++) {
    const d = new Date(trendStart.getTime() + i * 24 * 60 * 60 * 1000);
    trendByDay.set(dayKey(d), {
      llmTotal: 0,
      llmSucceeded: 0,
      rerunTotal: 0,
      rerunSucceeded: 0,
      navActions: 0,
      navChanges: 0,
      locatorActions: 0,
      locatorChanges: 0,
    });
  }

  for (const attempt of healingAttempts) {
    const k = dayKey(attempt.createdAt);
    const row = trendByDay.get(k);
    if (!row) continue;
    row.llmTotal += 1;
    if (attempt.status === "succeeded") row.llmSucceeded += 1;
  }
  for (const rerun of selfHealReruns) {
    const k = dayKey(rerun.createdAt);
    const row = trendByDay.get(k);
    if (!row) continue;
    row.rerunTotal += 1;
    if (rerun.status === "succeeded") row.rerunSucceeded += 1;
  }
  for (const record of recentTelemetry) {
    const ts = Date.parse(record.ts);
    if (!Number.isFinite(ts)) continue;
    const k = dayKey(ts);
    const row = trendByDay.get(k);
    if (!row) continue;
    if (record.event === "nav_suggestion_promoted" || record.event === "nav_promote_high_confidence") {
      row.navActions += 1;
      if (record.event === "nav_suggestion_promoted") row.navChanges += 1;
      else {
        const promotedCount = Number(record.properties?.promotedCount ?? 0);
        if (Number.isFinite(promotedCount) && promotedCount > 0) row.navChanges += 1;
      }
    }
    if (
      record.event === "locator_promoted" ||
      record.event === "locator_promote_all" ||
      record.event === "locator_promote_high_confidence"
    ) {
      row.locatorActions += 1;
      if (record.event === "locator_promoted") row.locatorChanges += 1;
      else if (record.event === "locator_promote_all") {
        const saved = Number(record.properties?.saved ?? 0);
        if (Number.isFinite(saved) && saved > 0) row.locatorChanges += 1;
      } else {
        const promotedCount = Number(record.properties?.promotedCount ?? 0);
        if (Number.isFinite(promotedCount) && promotedCount > 0) row.locatorChanges += 1;
      }
    }
  }
  const trend = Array.from(trendByDay.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, row]) => ({
      day,
      llmPatchSuccessRate: row.llmTotal > 0 ? row.llmSucceeded / row.llmTotal : null,
      selfHealRerunPassRate: row.rerunTotal > 0 ? row.rerunSucceeded / row.rerunTotal : null,
      navPromotionYieldRate: row.navActions > 0 ? row.navChanges / row.navActions : null,
      locatorPromotionYieldRate: row.locatorActions > 0 ? row.locatorChanges / row.locatorActions : null,
      counts: {
        healingAttempts: row.llmTotal,
        selfHealReruns: row.rerunTotal,
        navPromotionActions: row.navActions,
        locatorPromotionActions: row.locatorActions,
      },
    }));

  return reply.send({
    windowDays: days,
    since: since.toISOString(),
    metrics: {
      llmPatchSuccessRate,
      selfHealRerunPassRate,
      firstRerunPassRate,
      meanTimeToGreenMinutes,
      weakLocatorCount,
      navPromotionYieldRate,
      locatorPromotionYieldRate,
      counts: {
        healingAttempts: healingTotal,
        selfHealReruns: rerunTotal,
        failedParents: parentRuns.length,
        navPromotionActions: navPromotionActions.length,
        locatorPromotionActions: locatorPromotionActions.length,
      },
      trend,
    },
  });
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
  if (!allowLocalRecorderHelper) {
    app.log.info("[recorder] local helper disabled in production");
    return;
  }
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
      const ok = await checkRecorderHelperStatus(helperUrl);
      if (!ok) throw new Error("status not ok");
      return { started: true, configured: true, mode: "remote", helperUrl };
    } catch {
      return { started: false, configured: true, mode: "remote", helperUrl };
    }
  }

  if (!allowLocalRecorderHelper) {
    return { started: false, configured: false, mode: "remote", helperUrl: null };
  }

  return {
    started: !!recorderState.__tmRecorderHelperStarted,
    configured: !!validatedEnv.START_RECORDER_HELPER,
    mode: "local",
    helperUrl: recorderState.__tmRecorderHelperStarted ? "http://localhost:43117" : null,
    helperPath: path.join(REPO_ROOT, "recorder-helper.js"),
  };
});

app.post("/recorder/helper/start", async () => {
  const helperUrl = process.env.RECORDER_HELPER || null;
  if (helperUrl) {
    try {
      const ok = await checkRecorderHelperStatus(helperUrl);
      return { started: ok, configured: true, mode: "remote", helperUrl };
    } catch {
      return { started: false, configured: true, mode: "remote", helperUrl };
    }
  }

  if (!allowLocalRecorderHelper) {
    return { started: false, configured: false, mode: "remote", helperUrl: null };
  }

  startRecorderHelper(true);
  return {
    started: !!recorderState.__tmRecorderHelperStarted,
    mode: "local",
    helperUrl: recorderState.__tmRecorderHelperStarted ? "http://localhost:43117" : null,
  };
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

  // Ensure user exists and has a non-null plan.
  let user = (await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, plan: true, createdAt: true },
  })) as { id: string; plan: PlanTier | null; createdAt: Date } | null;
  if (!user) {
    user = (await prisma.user.create({
      data: { id: userId, plan: "free" },
      select: { id: true, plan: true, createdAt: true },
    })) as { id: string; plan: PlanTier | null; createdAt: Date };
  } else if (!user.plan) {
    user = (await prisma.user.update({
      where: { id: userId },
      data: { plan: "free" },
      select: { id: true, plan: true, createdAt: true },
    })) as { id: string; plan: PlanTier | null; createdAt: Date };
  }

  const plan = user.plan as PlanTier;
  return { plan, limits: getLimitsForPlan(plan) };
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
    create: { id: userId, plan: "free" },
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
