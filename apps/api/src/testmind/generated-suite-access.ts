export function logicalProjectIdFromGeneratedPath(relativePath: unknown) {
  if (typeof relativePath !== "string") return null;
  const normalized = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return null;
  const [projectId] = segments;
  if (!projectId || projectId === "." || projectId === "..") return null;
  return { projectId, normalized };
}
