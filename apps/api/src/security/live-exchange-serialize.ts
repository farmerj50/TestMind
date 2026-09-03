import type { SecurityHttpExchange } from "./http-exchange.js";

// Shared by the live-security WebSocket broadcast path (live-security-session.ts) and the
// Ticket 0.5 REST history routes (routes/security.ts) so the two can never drift on what
// gets truncated/redacted before reaching a client — the whole point of extracting this is
// that there is exactly one place that decides what's safe to send, used by both paths.

export const MAX_CAPTURED_BODY_CHARS = 128_000;
export const MAX_CAPTURED_POST_DATA_CHARS = 32_000;

const SENSITIVE_HEADER_RE =
  /^(authorization|cookie|set-cookie|proxy-authorization|x-api-key|api-key|x-auth-token|x-session|x-session-id|x-csrf-token|x-xsrf-token)$/i;

export function truncateText(value: string | undefined, maxChars: number): string | undefined {
  if (value === undefined) return undefined;
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n...[truncated ${value.length - maxChars} chars by TestMind live capture]`;
}

export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = SENSITIVE_HEADER_RE.test(key) ? "[REDACTED]" : value;
  }
  return out;
}

export function clientExchange(exchange: SecurityHttpExchange): SecurityHttpExchange {
  return {
    ...exchange,
    request: {
      ...exchange.request,
      headers: redactHeaders(exchange.request.headers),
      postData: truncateText(exchange.request.postData, MAX_CAPTURED_POST_DATA_CHARS),
    },
    response: exchange.response
      ? {
          ...exchange.response,
          headers: redactHeaders(exchange.response.headers),
          body: truncateText(exchange.response.body, MAX_CAPTURED_BODY_CHARS),
        }
      : undefined,
  };
}
