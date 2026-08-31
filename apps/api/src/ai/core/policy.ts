export type AiRepairConfig = {
  structuredPatch: boolean;
  allowFullRewriteFallback: boolean;
  structuredTimeoutMs: number;
  totalTimeoutMs: number;
  maxPatchOps: number;
  maxPatchText: number;
  maxChangedLines: number;
  maxBytesDelta: number;
};

// Tier 2 (live-page selector probing) config. Two independent flags, not one: `enabled`
// gates whether the probe runs at all (repairs happen, verified by the normal rerun, but
// nothing is written to sharedSteps); `autoPromoteEnabled` independently gates whether a
// verified selector gets promoted to the project's shared locator store. Both default off.
export type LiveProbeConfig = {
  enabled: boolean;
  autoPromoteEnabled: boolean;
  navigationTimeoutMs: number;
  perCandidateTimeoutMs: number;
  totalBudgetMs: number;
  maxSitesPerAttempt: number;
};

export type SelfHealPolicy = {
  workerConcurrency: number;
  healOnly: boolean;
  repair: AiRepairConfig;
  liveProbe: LiveProbeConfig;
};

export function resolveRepairConfigForFramework(
  config: AiRepairConfig,
  adapterId?: string | null
): AiRepairConfig {
  if (adapterId !== "playwright-ts") return config;

  // Generated Playwright specs can be substantially larger than Cucumber feature files.
  // Keep the stricter shared defaults for other frameworks, but allow a larger bounded patch
  // for the stable Playwright self-heal path.
  return {
    ...config,
    maxChangedLines: Math.max(config.maxChangedLines, 450),
    maxBytesDelta: Math.max(config.maxBytesDelta, 50000),
  };
}

const parseBoolEnv = (value: string | undefined, fallback: boolean) => {
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  return fallback;
};

const parseIntEnv = (
  value: string | undefined,
  fallback: number,
  min = 1,
  max = Number.MAX_SAFE_INTEGER
) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
};

export function readSelfHealPolicy(env: NodeJS.ProcessEnv = process.env): SelfHealPolicy {
  const totalTimeoutMs = parseIntEnv(env.SELF_HEAL_TIMEOUT_MS, 120000, 5000);
  return {
    workerConcurrency: parseIntEnv(env.SELF_HEAL_CONCURRENCY, 1, 1),
    healOnly: parseBoolEnv(env.SELF_HEAL_HEAL_ONLY, false),
    repair: {
      structuredPatch: parseBoolEnv(env.SELF_HEAL_STRUCTURED_PATCH, true),
      allowFullRewriteFallback: parseBoolEnv(env.SELF_HEAL_ALLOW_FULL_REWRITE_FALLBACK, true),
      structuredTimeoutMs: parseIntEnv(
        env.SELF_HEAL_STRUCTURED_TIMEOUT_MS,
        Math.min(45000, totalTimeoutMs),
        5000,
        totalTimeoutMs
      ),
      totalTimeoutMs,
      maxPatchOps: parseIntEnv(env.SELF_HEAL_MAX_PATCH_OPS, 8, 1, 50),
      maxPatchText: parseIntEnv(env.SELF_HEAL_MAX_PATCH_TEXT, 8000, 200, 20000),
      maxChangedLines: parseIntEnv(env.SELF_HEAL_MAX_CHANGED_LINES, 220, 1),
      maxBytesDelta: parseIntEnv(env.HEAL_MAX_BYTES_DELTA, 28000, 1),
    },
    liveProbe: {
      enabled: parseBoolEnv(env.SELF_HEAL_LIVE_PROBE_ENABLED, false),
      autoPromoteEnabled: parseBoolEnv(env.SELF_HEAL_LIVE_PROBE_AUTO_PROMOTE_ENABLED, false),
      navigationTimeoutMs: parseIntEnv(env.SELF_HEAL_LIVE_PROBE_NAV_TIMEOUT_MS, 8000, 1000, 20000),
      perCandidateTimeoutMs: parseIntEnv(env.SELF_HEAL_LIVE_PROBE_CANDIDATE_TIMEOUT_MS, 900, 200, 5000),
      totalBudgetMs: parseIntEnv(env.SELF_HEAL_LIVE_PROBE_BUDGET_MS, 12000, 2000, 30000),
      maxSitesPerAttempt: parseIntEnv(env.SELF_HEAL_LIVE_PROBE_MAX_SITES, 4, 1, 10),
    },
  };
}
