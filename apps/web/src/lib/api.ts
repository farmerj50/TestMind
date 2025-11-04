// apps/web/src/lib/api.ts
import { useAuth } from "@clerk/clerk-react";

const DEFAULT_BASE = "http://localhost:8787"; // <- put your real API port
type ApiInit = RequestInit & { auth?: "include" | "omit" };

export function useApi() {
  const { getToken } = useAuth();
  const BASE = (import.meta.env.VITE_API_URL as string) || DEFAULT_BASE;

  function normalize(path: string) {
    let p = (path || "").trim();
    // if someone passed a full URL, just use it
    if (/^https?:\/\//i.test(p)) return p;
    // SURGICAL: kill accidental /tm prefix from any caller
    if (p.startsWith("/tm/")) p = p.slice(3);         // "/tm/foo" -> "/foo"
    if (p === "/tm") p = "/";
    // ensure single leading slash
    return p.startsWith("/") ? p : `/${p}`;
  }

  function buildUrl(path: string) {
    const clean = normalize(path);
    const baseWithSlash = BASE.endsWith("/") ? BASE : BASE + "/";
    const cleanPath = clean.replace(/^\//, "");
    return new URL(cleanPath, baseWithSlash).toString();
  }

  // keep the rest of the file exactly as-is

async function apiFetch<T = any>(path: string, init: ApiInit = {}): Promise<T> {
  const url = buildUrl(path);

  const method = (init.method ?? "GET").toString().toUpperCase();
  // Only include auth on non-GET, or when explicitly requested for GET
  const wantAuth = method !== "GET" ? true : init.auth === "include";
  const token = wantAuth ? await getToken().catch(() => undefined) : undefined;

  const headers = new Headers(init.headers || {});
  // Set Content-Type only when there is a body
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
}


  return { apiFetch };
}
