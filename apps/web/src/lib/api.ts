// apps/web/src/lib/api.ts
import { useCallback } from "react";
import { useAuth } from "@clerk/clerk-react";

const DEFAULT_BASE = "http://localhost:8787"; // dev API URL
type ApiInit = RequestInit & { auth?: "include" | "omit" };

/** Helper used by Run button (sends JSON). */
export async function startRun(apiFetch: any, projectId: string) {
  return apiFetch("/runner/run", {
    method: "POST",
    body: JSON.stringify({ projectId }),
  });
}

export function useApi() {
  const { getToken } = useAuth();
  const BASE = (import.meta.env.VITE_API_URL as string) || DEFAULT_BASE;

  function normalize(path: string) {
    let p = (path || "").trim();
    if (/^https?:\/\//i.test(p)) return p;            // full URL passed
    if (p.startsWith("/tm/")) p = p.slice(3);         // strip accidental /tm
    if (p === "/tm") p = "/";
    return p.startsWith("/") ? p : `/${p}`;
  }

  function buildUrl(path: string) {
    const clean = normalize(path);
    const baseWithSlash = BASE.endsWith("/") ? BASE : BASE + "/";
    const cleanPath = clean.replace(/^\//, "");
    return new URL(cleanPath, baseWithSlash).toString();
  }

  /** Stable fetch wrapper for components/effects. */
  const apiFetch = useCallback(
    async <T = any>(path: string, init: ApiInit = {}): Promise<T> => {
      const url = buildUrl(path);

      const method = (init.method ?? "GET").toString().toUpperCase();
      // Include auth token for non-GET, or when explicitly requested
      const wantAuth = method !== "GET" ? true : init.auth === "include";
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
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(text || `${res.status} ${res.statusText}`);
      }
      return res.json() as Promise<T>;
    },
    [BASE, getToken] // stable deps
  );

  return { apiFetch };
}
