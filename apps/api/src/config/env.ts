// apps/api/src/config/env.ts
import { z } from "zod";

const EnvSchema = z.object({
  NODE_ENV: z.string().default("development"),
  PORT: z.coerce.number().int().positive().max(65535).default(8787),

  DATABASE_URL: z.string().trim().min(1, "DATABASE_URL is required"),
  REDIS_URL: z.string().trim().min(1, "REDIS_URL is required"),
  SECRET_KEY: z.string().trim().min(1, "SECRET_KEY is required"),

  CLERK_PUBLISHABLE_KEY: z.string().trim().min(1, "CLERK_PUBLISHABLE_KEY is required"),
  CLERK_SECRET_KEY: z.string().trim().min(1, "CLERK_SECRET_KEY is required"),

  CORS_ORIGINS: z.string().optional(),
  ALLOW_PLAN_PATCH: z.string().optional(),
  START_WORKERS: z.string().optional(),
  TM_SKIP_SERVER: z.string().optional(),
  ENABLE_DEBUG_ROUTES: z.string().optional(),
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
  throw new Error(`Invalid environment configuration: ${issues}`);
}

const env = parsed.data;

const parseBoolean = (value: string | undefined, fallback: boolean, name: string) => {
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  throw new Error(`Invalid boolean for ${name}: use true/false/1/0/yes/no`);
};

// Build the CORS origin list, failing fast in production if unset.
const corsList =
  (env.CORS_ORIGINS || "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);

if (env.NODE_ENV === "production" && corsList.length === 0) {
  throw new Error("CORS_ORIGINS is required in production (comma-separated list).");
}

// Provide sane defaults for local dev without loosening production requirements.
const devDefaultCors = ["http://localhost:5173", "http://localhost:5174", "http://localhost:5175"];

export const validatedEnv = {
  ...env,
  NODE_ENV: env.NODE_ENV || "development",
  PORT: env.PORT ?? 8787,
  CORS_ORIGIN_LIST: corsList.length ? corsList : devDefaultCors,
  SECRET_KEY: env.SECRET_KEY,
  START_WORKERS: parseBoolean(env.START_WORKERS, true, "START_WORKERS"),
  TM_SKIP_SERVER: parseBoolean(env.TM_SKIP_SERVER, false, "TM_SKIP_SERVER"),
  ENABLE_DEBUG_ROUTES: parseBoolean(env.ENABLE_DEBUG_ROUTES, false, "ENABLE_DEBUG_ROUTES"),
};

// Validate SECRET_KEY format (32-byte base64 for AES-256-GCM).
const keyBuf = Buffer.from(validatedEnv.SECRET_KEY, "base64");
if (keyBuf.length !== 32) {
  throw new Error("SECRET_KEY must be a base64-encoded 32-byte string (AES-256-GCM).");
}

export const secretKeyBuffer = keyBuf;
