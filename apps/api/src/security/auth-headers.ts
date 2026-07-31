import type { SecurityAuthProfile } from "./types.js";

export function buildAuthHeaders(profile?: SecurityAuthProfile): Record<string, string> {
  const extra = profile?.additionalHeaders ?? {};
  if (!profile || profile.type === "none") return { ...extra };
  if (profile.type === "bearer" && profile.token) {
    return { Authorization: `Bearer ${profile.token}`, ...extra };
  }
  if (profile.type === "cookie" && profile.cookieValue) {
    const cookieHeader =
      profile.cookieName === "__raw__"
        ? profile.cookieValue
        : `${profile.cookieName || "session"}=${profile.cookieValue}`;
    return { Cookie: cookieHeader, ...extra };
  }
  if (profile.type === "basic" && profile.username && profile.password) {
    return {
      Authorization: `Basic ${Buffer.from(`${profile.username}:${profile.password}`).toString("base64")}`,
      ...extra,
    };
  }
  return { ...extra };
}
