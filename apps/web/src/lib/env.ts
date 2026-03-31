// apps/web/src/lib/env.ts
// Preferred: set VITE_API_URL to the API origin. Dev fallback uses localhost:8787.
const DEV_API_FALLBACK = "http://localhost:8787";

const configuredApi = import.meta.env.VITE_API_URL;
const runtimeFallback =
  typeof window !== "undefined"
    ? window.location.origin
    : DEV_API_FALLBACK;
export const API_URL: string =
  configuredApi && configuredApi.trim().length > 0 ? configuredApi : runtimeFallback;

// Helper to build API links against the configured (or fallback) origin
export function apiHref(path: string) {
  // ensure path starts with a single leading slash
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${API_URL}${p}`;
}
