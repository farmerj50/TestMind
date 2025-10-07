// apps/web/src/lib/env.ts
export const API_URL: string = import.meta.env.VITE_API_URL ?? "";

// Optional: helper to build API links with a fallback
export function apiHref(path: string) {
  // ensure path starts with a single leading slash
  const p = path.startsWith("/") ? path : `/${path}`;
  return API_URL ? `${API_URL}${p}` : p; // fallback to same-origin if API_URL is empty
}
