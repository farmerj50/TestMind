const SECRET_KEY_PATTERN =
  /(authorization|bearer|token|cookie|password|secret|api[-_]?key|session|jwt|credential)/i;

export function redactText(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]")
    .replace(/Basic\s+[A-Za-z0-9+/]+=*/gi, "Basic [REDACTED]")
    .replace(
      /(token|password|secret|api[-_]?key|session|jwt|cookie)\s*[:=]\s*["']?[^"',\s;}]+/gi,
      "$1=[REDACTED]"
    )
    .replace(/([A-Za-z0-9_%-]+)=([^;\s]{12,})/g, "$1=[REDACTED]");
}

export function redactJson<T>(input: T): T {
  if (input == null) return input;
  if (typeof input === "string") return redactText(input) as T;
  if (typeof input !== "object") return input;
  if (Array.isArray(input)) return input.map((item) => redactJson(item)) as T;

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (SECRET_KEY_PATTERN.test(key)) {
      out[key] = value ? "[REDACTED]" : value;
      continue;
    }
    out[key] = redactJson(value);
  }
  return out as T;
}

export function snippet(value: string, maxLength = 220): string {
  const compact = redactText(value).replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, maxLength)}...[truncated]`;
}

export function redactAuthProfileForStorage(profile: Record<string, unknown>) {
  const copy = { ...profile };
  delete copy.token;
  delete copy.cookieValue;
  delete copy.password;
  return redactJson(copy);
}
