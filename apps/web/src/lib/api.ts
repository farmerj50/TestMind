import { useAuth } from "@clerk/clerk-react";

const DEFAULT_BASE = "http://localhost:8787";

export function useApi() {
  const { getToken } = useAuth();
  const BASE = (import.meta.env.VITE_API_URL as string) || DEFAULT_BASE;

  async function apiFetch<T = any>(path: string, init?: RequestInit): Promise<T> {
    // robust join: exactly one slash between base and path
    const baseWithSlash = BASE.endsWith("/") ? BASE : BASE + "/";
    const cleanPath = path.replace(/^\//, "");
    const url = new URL(cleanPath, baseWithSlash).toString();

    const token = await getToken().catch(() => undefined);

    const res = await fetch(url, {
      credentials: "include",
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(init?.headers as Record<string, string> | undefined),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(text || `${res.status} ${res.statusText}`);
    }
    return res.json() as Promise<T>;
  }

  return { apiFetch };
}
