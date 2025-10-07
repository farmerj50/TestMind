import { useAuth } from "@clerk/clerk-react";

export function useApi() {
  const { getToken } = useAuth();
  const base = import.meta.env.VITE_API_URL;

  async function apiFetch<T = any>(
    path: string,
    init: RequestInit & { body?: any } = {}
  ): Promise<T> {
    const token = await getToken();
    const hasBody = init.body !== undefined && init.body !== null;

    const res = await fetch(`${base}${path}`, {
      method: init.method ?? "GET",
      credentials: "include",
      headers: {
        ...(hasBody ? { "Content-Type": "application/json" } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(init.headers || {}),
      },
      body: hasBody
        ? typeof init.body === "string"
          ? init.body
          : JSON.stringify(init.body)
        : undefined,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(text || res.statusText);
    }
    return (await res.json()) as T;
  }

  return { apiFetch };
}
