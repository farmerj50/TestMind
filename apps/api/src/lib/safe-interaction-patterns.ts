// Shared by runner/live-security-session.ts (the automated site-walk) and
// runner/interactive-ui-agent.ts (the Interactive UI Testing agent loop) - both need the
// identical "never touch logout/delete/purchase/payment/etc." denylist so the two call sites can
// never drift apart. Extracted here once both needed it; behavior-preserving move, not a rewrite.

export const DANGEROUS_ROUTE_RE =
  /(logout|log-out|signout|sign-out|delete|remove|destroy|deactivate|close-account|cancel|billing|checkout|payment|purchase|subscribe|transfer|withdraw|deposit|fund|trade|buy|sell|invest|order|confirm|submit|upload|enroll|enrol|sign-up|signup|register|apply|application|finish|continue)/i;

export const SAFE_SEARCH_INPUT_RE = /(search|filter|query|find|lookup)/i;

export function isDangerousSignal(signal: string): boolean {
  return DANGEROUS_ROUTE_RE.test(signal.toLowerCase());
}

export function isStaticPath(pathname: string): boolean {
  return /\.(?:css|js|mjs|map|png|jpe?g|gif|webp|svg|ico|woff2?|ttf|pdf|zip)$/i.test(pathname);
}
