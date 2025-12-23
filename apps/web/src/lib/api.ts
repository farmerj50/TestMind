// apps/web/src/lib/api.ts
import { useCallback } from "react";
import { useAuth } from "@clerk/clerk-react";

const DEFAULT_BASE = "http://localhost:8787"; // dev API URL
const ENV_BASE = (import.meta.env.VITE_API_URL ?? "").trim().replace(/\/$/, "");
export const API_BASE = ENV_BASE || (import.meta.env.DEV ? DEFAULT_BASE : "");
type ApiInit = RequestInit & { auth?: "include" | "omit" };

function buildBaseUrl(path: string) {
  const normalized = path.trim();
  const relative = normalized.startsWith("/") ? normalized.slice(1) : normalized;
  const base = API_BASE || DEFAULT_BASE;
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

  /** Stable fetch wrapper for components/effects. */
  const apiFetch = useCallback(
    async <T = any>(path: string, init: ApiInit = {}): Promise<T> => {
      const url = buildUrl(path);

      // Always include auth unless explicitly opted out with auth: "omit"
      const wantAuth = init.auth !== "omit";
      const token = wantAuth ? await getToken().catch(() => undefined) : undefined;

      const headers = new Headers(init.headers || {});
      // Only set Content-Type when there is a body and user didn't override
      if (init.body && !headers.has("Content-Type")) {
        headers.set("Content-Type", "application/json");
      }
      if (token && !headers.has("Authorization")) {
        headers.set("Authorization", `Bearer ${token}`);
      }

      const res = await fetch(url, { ...init, headers, credentials: "include" });
      const contentType = res.headers.get("content-type") ?? "";
      if (!res.ok) {
        const text = contentType.includes("application/json")
          ? JSON.stringify(await res.json().catch(() => null))
          : await res.text().catch(() => "");
        throw new Error(text || `${res.status} ${res.statusText}`);
      }
      if (!contentType.includes("application/json")) {
        return await res.text().catch(() => "") as T;
      }
      return res.json() as Promise<T>;
    },
    [BASE, getToken] // stable deps
  );

  return { apiFetch };
}
