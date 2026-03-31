// apps/web/src/lib/api.ts
import { useCallback } from "react";
import { useAuth } from "@clerk/clerk-react";

const DEV_HOST =
  typeof window !== "undefined" && window.location.hostname
    ? window.location.hostname
    : "localhost";
const DEV_PROTOCOL =
  typeof window !== "undefined" && window.location.protocol === "https:"
    ? "https"
    : "http";
const DEFAULT_DEV_BASE = `${DEV_PROTOCOL}://${DEV_HOST}:8787`; // local API URL in dev
const ENV_BASE = (import.meta.env.VITE_API_URL ?? "").trim().replace(/\/$/, "");
const RUNTIME_BASE =
  typeof window !== "undefined" ? window.location.origin : DEFAULT_DEV_BASE;
export const API_BASE = ENV_BASE || (import.meta.env.DEV ? DEFAULT_DEV_BASE : RUNTIME_BASE);
type ApiInit = RequestInit & { auth?: "include" | "omit" };

function buildBaseUrl(path: string) {
  const normalized = path.trim();
  const relative = normalized.startsWith("/") ? normalized.slice(1) : normalized;
  const base = API_BASE;
  const baseWithSlash = base.endsWith("/") ? base : `${base}/`;
  return new URL(relative, baseWithSlash).toString();
}

export function apiUrl(path: string) {
  return buildBaseUrl(path);
}

/** Helper used by Run button (sends JSON). */
export async function startRun(apiFetch: any, projectId: string) {
  return apiFetch("/runner/run", {
    method: "POST",
    body: JSON.stringify({ projectId }),
  });
}

export function useApi() {
  const { getToken } = useAuth();
  function buildUrl(path: string) {
    return apiUrl(path);
  }

  const readErrorText = async (res: Response) => {
    const contentType = res.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      return JSON.stringify(await res.json().catch(() => null));
    }
    return await res.text().catch(() => "");
  };

  /** Stable fetch wrapper for components/effects. */
  const apiFetch = useCallback(
    async <T = any>(path: string, init: ApiInit = {}): Promise<T> => {
      const url = buildUrl(path);

      // Always include auth unless explicitly opted out with auth: "omit"
      const wantAuth = init.auth !== "omit";
      let token = wantAuth ? await getToken().catch(() => undefined) : undefined;

      const runFetch = async (tokenOverride?: string | null) => {
        const headers = new Headers(init.headers || {});
        if (init.body && !headers.has("Content-Type")) {
          headers.set("Content-Type", "application/json");
        }
        if (wantAuth) {
          if (headers.has("Authorization")) {
            // Keep caller-specified authorization header.
          } else if (tokenOverride) {
            headers.set("Authorization", `Bearer ${tokenOverride}`);
          }
        }
        return fetch(url, { ...init, headers, credentials: "include" });
      };

      let res = await runFetch(token);
      if (wantAuth && res.status === 401) {
        const refreshed = await getToken({ skipCache: true }).catch(() => undefined);
        if (refreshed && refreshed !== token) {
          token = refreshed;
          res = await runFetch(token);
        }
      }

      const contentType = res.headers.get("content-type") ?? "";
      if (!res.ok) {
        const text = await readErrorText(res);
        throw new Error(text || `${res.status} ${res.statusText}`);
      }
      if (!contentType.includes("application/json")) {
        return await res.text().catch(() => "") as T;
      }
      return res.json() as Promise<T>;
    },
    [getToken] // stable deps
  );

  const apiFetchRaw = useCallback(
    async (path: string, init: ApiInit = {}): Promise<Response> => {
      const url = buildUrl(path);

      const wantAuth = init.auth !== "omit";
      let token = wantAuth ? await getToken().catch(() => undefined) : undefined;

      const runFetch = async (tokenOverride?: string | null) => {
        const headers = new Headers(init.headers || {});
        if (init.body && !headers.has("Content-Type")) {
          headers.set("Content-Type", "application/json");
        }
        if (wantAuth) {
          if (headers.has("Authorization")) {
            // Keep caller-specified authorization header.
          } else if (tokenOverride) {
            headers.set("Authorization", `Bearer ${tokenOverride}`);
          }
        }
        return fetch(url, { ...init, headers, credentials: "include" });
      };

      let res = await runFetch(token);
      if (wantAuth && res.status === 401) {
        const refreshed = await getToken({ skipCache: true }).catch(() => undefined);
        if (refreshed && refreshed !== token) {
          token = refreshed;
          res = await runFetch(token);
        }
      }
      return res;
    },
    [getToken]
  );

  return { apiFetch, apiFetchRaw };
}
