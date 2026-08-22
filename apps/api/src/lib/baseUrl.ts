// Centralized precedence resolution for "what is this project's target/base URL."
// Historically this was reimplemented independently in ~14 places (8 backend, 6 frontend),
// each with a DIFFERENT precedence order — some skip sharedSteps.baseUrl entirely, one ranks
// a separate Environment entity above everything else, one does zero URL validation. This
// module doesn't invent new validation logic: it reuses the existing, already-shared
// `isLikelyGitRepoUrl` helper from ./git-url.js for "does this look like a git remote, not a
// real target site" and leaves that as the single source of truth for that check.
//
// Callers with genuinely different needs (e.g. a rerun preferring the original run's stored
// baseUrl over the live project setting, or a job type that should throw instead of silently
// defaulting) opt into their own `order` rather than being forced through one universal chain.
//
// Nothing calls this module yet — it ships with zero callers, migrated in individually per the
// project plan.
import { isLikelyGitRepoUrl } from "./git-url.js";

export interface BaseUrlSources {
  /** Highest-priority override, e.g. an explicit request param or a rerun's original params.baseUrl. */
  override?: string | null;
  sharedStepsBaseUrl?: string | null;
  /** The separate Environment DB entity's baseUrl, used today only by routes/workflows.ts. */
  environmentBaseUrl?: string | null;
  /** Validated via isLikelyGitRepoUrl before being treated as a usable target URL. */
  repoUrl?: string | null;
  /** Env var names checked in this order, e.g. ["TM_BASE_URL", "TEST_BASE_URL"]. */
  envVarNames?: string[];
  /** Last-resort default, e.g. "http://localhost:5173". Not validated. */
  fallback?: string | null;
}

type SourceKey = keyof BaseUrlSources;

export interface ResolveBaseUrlOptions {
  /**
   * Explicit precedence order. Defaults to the most common chain found across existing
   * call sites: override > sharedStepsBaseUrl > repoUrl > environmentBaseUrl > envVarNames >
   * fallback. Pass a custom order for callers with different needs instead of bypassing this
   * module for a "special case."
   */
  order?: SourceKey[];
}

const DEFAULT_ORDER: SourceKey[] = [
  "override",
  "sharedStepsBaseUrl",
  "repoUrl",
  "environmentBaseUrl",
  "envVarNames",
  "fallback",
];

const isLocalHost = (host: string) => /^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?$/i.test(host);

/** Adds a protocol if missing (http for local-looking hosts, https otherwise) and strips a
 *  trailing slash. Does not otherwise validate the URL — callers that need strict validation
 *  should use validateAndNormalizeProjectUrl from ./git-url.js on the result. */
function normalizeFlexibleUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed.replace(/\/+$/, "");
  const hostPart = trimmed.split(/[/?#]/)[0] ?? trimmed;
  const protocol = isLocalHost(hostPart) ? "http" : "https";
  return `${protocol}://${trimmed}`.replace(/\/+$/, "");
}

/** repoUrl is validated more strictly than the other free-text sources: it must already look
 *  like a real http(s) URL (no protocol coercion) and must NOT look like a git remote — a repo
 *  URL pointing at a git host is not a usable test target. */
function normalizeRepoUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (isLikelyGitRepoUrl(trimmed)) return null;
  if (!/^https?:\/\//i.test(trimmed)) return null;
  return trimmed.replace(/\/+$/, "");
}

/**
 * Single source of truth for base-URL precedence. Returns the first source in `order` (or the
 * default order) that is present and passes validation, or `null` if none apply.
 */
export function resolveBaseUrl(sources: BaseUrlSources, options?: ResolveBaseUrlOptions): string | null {
  const order = options?.order ?? DEFAULT_ORDER;
  for (const key of order) {
    if (key === "envVarNames") {
      for (const name of sources.envVarNames ?? []) {
        const fromEnv = normalizeFlexibleUrl(process.env[name] ?? "");
        if (fromEnv) return fromEnv;
      }
      continue;
    }
    if (key === "repoUrl") {
      const normalized = sources.repoUrl ? normalizeRepoUrl(sources.repoUrl) : null;
      if (normalized) return normalized;
      continue;
    }
    if (key === "fallback") {
      const trimmed = sources.fallback?.trim();
      if (trimmed) return trimmed;
      continue;
    }
    const raw = sources[key] as string | null | undefined;
    const normalized = raw ? normalizeFlexibleUrl(raw) : null;
    if (normalized) return normalized;
  }
  return null;
}
