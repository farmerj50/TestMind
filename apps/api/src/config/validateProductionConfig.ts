// Phase 5: production configuration validation. A real, tested, standalone function - NOT
// wired into index.ts's boot path. Wiring it into the real boot sequence is a production
// behavior change outside this phase's authorization; that remains a separate, explicitly
// authorized step. Takes a plain env-like record rather than reading config/env.ts's
// module-level `validatedEnv` singleton, since that singleton already throws at import time
// if required vars are missing - this function must be callable (and testable) against an
// arbitrary, possibly-incomplete env object.

export type EnvLike = Record<string, string | undefined>;

const REQUIRED_ALWAYS = ["DATABASE_URL", "REDIS_URL", "SECRET_KEY", "CLERK_PUBLISHABLE_KEY", "CLERK_SECRET_KEY"] as const;

export function validateProductionConfig(env: EnvLike): void {
  if (env.NODE_ENV !== "production") return;

  const missing: string[] = [];

  for (const key of REQUIRED_ALWAYS) {
    if (!env[key] || !env[key]!.trim()) missing.push(key);
  }

  if (env.SECRET_KEY && env.SECRET_KEY.trim()) {
    const keyBuf = Buffer.from(env.SECRET_KEY, "base64");
    if (keyBuf.length !== 32) missing.push("SECRET_KEY (must be a base64-encoded 32-byte string for AES-256-GCM)");
  }

  // Evaluation features are only "enabled" if either of these is set at all - if neither is
  // set, evaluation runs simply fail lazily at call time (existing Phase 1 behavior), so this
  // isn't a hard production requirement unless the operator has started configuring it.
  const evalConfigured = !!env.TM_EVAL_SERVICE_URL || !!env.TM_EVAL_SERVICE_API_KEY;
  if (evalConfigured) {
    if (!env.TM_EVAL_SERVICE_URL || !env.TM_EVAL_SERVICE_URL.trim()) missing.push("TM_EVAL_SERVICE_URL (required once evaluation features are enabled)");
    if (!env.TM_EVAL_SERVICE_API_KEY || !env.TM_EVAL_SERVICE_API_KEY.trim()) missing.push("TM_EVAL_SERVICE_API_KEY (required once evaluation features are enabled)");
  }

  if (!env.CORS_ORIGINS && !env.WEB_URL) {
    missing.push("CORS_ORIGINS or WEB_URL (at least one required in production)");
  }

  if (missing.length) {
    throw new Error(`Production configuration is incomplete. Missing/invalid: ${missing.join(", ")}`);
  }
}
