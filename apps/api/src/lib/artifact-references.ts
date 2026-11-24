// Raw provider URLs (including historical signed URLs) have no validated-copy or
// project-authorization guarantee. Do not emit them in public report contracts.
export function publicArtifactReferences(value: unknown, depth = 0): unknown {
  if (depth > 80) return '[artifact metadata withheld]';
  if (typeof value === 'string') {
    if (/^(?:https?:|s3:|gs:|file:|data:|\/\/|\\\\)/i.test(value.trim()) || /UEsDB|UEsFB/.test(value)) return '[restricted artifact reference]';
    try { return JSON.stringify(publicArtifactReferences(JSON.parse(value), depth + 1)); } catch { return value; }
  }
  if (Array.isArray(value)) return value.map(item => publicArtifactReferences(item, depth + 1));
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, publicArtifactReferences(item, depth + 1)]));
  return value;
}
