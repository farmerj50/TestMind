// Utility helpers for working with Playwright full test names.
const TITLE_SEPARATORS = />|›/;

export function extractTestTitle(fullName?: string | null): string | null {
  if (!fullName) return null;
  const parts = fullName
    .split(TITLE_SEPARATORS)
    .map((part) => part.trim())
    .filter(Boolean);
  const last = parts.length ? parts[parts.length - 1]! : fullName.trim();
  return last ? last : null;
}
