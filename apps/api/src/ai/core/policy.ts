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

export type SelfHealPolicy = {
  workerConcurrency: number;
  healOnly: boolean;
  repair: AiRepairConfig;
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
  const totalTimeoutMs = parseIntEnv(env.SELF_HEAL_TIMEOUT_MS, 240000, 5000);
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
  };
}
