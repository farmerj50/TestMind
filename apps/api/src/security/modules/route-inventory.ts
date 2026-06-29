import {
  isWithinScope,
  probeScoped,
  toAbsoluteUrl,
} from "../http-client.js";
import type {
  ApiSecurityFixture,
  ExpectedSecurityControl,
  IntelligentSecurityScanConfig,
  RouteInventoryItem,
  RouteInventorySource,
  RouteSecurityContract,
} from "../types.js";

const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"]);

const PROTECTED_PATH_MARKERS = [
  "account",
  "admin",
  "billing",
  "checkout",
  "dashboard",
  "invoice",
  "me",
  "order",
  "payment",
  "profile",
  "project",
  "report",
  "settings",
  "subscription",
  "tenant",
  "transaction",
  "user",
  "workspace",
];

const DEFAULT_FORBIDDEN_FIELDS = [
  "password",
  "passwordHash",
  "secret",
  "token",
  "apiKey",
  "accessToken",
  "refreshToken",
  "ssn",
  "cardNumber",
  "internalCost",
  "adminNotes",
];

const DEEP_HEURISTIC_ROUTES = [
  "/api/me",
  "/api/user",
  "/api/users/me",
  "/api/profile",
  "/api/account",
  "/api/accounts",
  "/api/session",
  "/api/auth/session",
  "/api/settings",
  "/api/billing",
  "/api/organizations",
  "/api/workspaces",
  "/graphql",
  "/api/graphql",
];

export type ApiSecurityFixtureSuggestion = ApiSecurityFixture & {
  source: RouteSecurityContract["source"];
  confidence: RouteSecurityContract["confidence"];
  rationale: string;
  objectIdRequired: boolean;
};

function routeKey(route: string, method: string) {
  return `${method.toUpperCase()} ${route}`;
}

function stripHashAndQuery(raw: string) {
  return raw.split("#")[0].split("?")[0] || "/";
}

export function normalizeRoutePath(raw: string): string {
  let path = raw;
  try {
    path = new URL(raw, "http://local.test").pathname;
  } catch {
    path = stripHashAndQuery(raw);
  }
  path = decodeURIComponent(path || "/");
  if (!path.startsWith("/")) path = `/${path}`;
  path = path.replace(/\/{2,}/g, "/");
  if (path.length > 1) path = path.replace(/\/$/, "");

  const segments = path.split("/").map((segment) => {
    if (/^\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(segment)) return ":id";
    if (/^:[A-Za-z_][A-Za-z0-9_]*$/.test(segment)) return ":id";
    if (/^\[[A-Za-z_][A-Za-z0-9_]*\]$/.test(segment)) return ":id";
    if (/^\d{1,18}$/.test(segment)) return ":id";
    if (/^[0-9a-f]{8}-[0-9a-f-]{13,}$/i.test(segment)) return ":id";
    if (/^c[a-z0-9]{12,}$/i.test(segment)) return ":id";
    if (/^[0-9a-f]{24}$/i.test(segment)) return ":id";
    return segment;
  });
  return segments.join("/") || "/";
}

function addRoute(
  routes: Map<string, RouteInventoryItem>,
  config: IntelligentSecurityScanConfig,
  routeOrUrl: string,
  method: string,
  source: RouteInventorySource
) {
  const upperMethod = method.toUpperCase();
  if (!HTTP_METHODS.has(upperMethod)) return;
  let url: string;
  try {
    url = toAbsoluteUrl(config.baseUrl, routeOrUrl);
  } catch {
    return;
  }
  if (!isWithinScope(url, config.allowedHosts, config.allowedPorts)) return;
  const route = normalizeRoutePath(url);
  const key = routeKey(route, upperMethod);
  if (!routes.has(key)) routes.set(key, { route, method: upperMethod, source, url });
}

function extractHtmlRoutes(
  config: IntelligentSecurityScanConfig,
  html: string,
  routes: Map<string, RouteInventoryItem>
) {
  const attrPattern = /\b(href|src|action)\s*=\s*["']([^"']+)["']/gi;
  for (const match of html.matchAll(attrPattern)) {
    const value = match[2]?.trim();
    if (!value || value.startsWith("#") || value.startsWith("mailto:") || value.startsWith("tel:")) {
      continue;
    }
    addRoute(routes, config, value, "GET", match[1]?.toLowerCase() === "action" ? "form" : "html");
  }

  const formPattern = /<form\b[^>]*\baction\s*=\s*["']([^"']+)["'][^>]*>/gi;
  for (const match of html.matchAll(formPattern)) {
    const tag = match[0] ?? "";
    const method = tag.match(/\bmethod\s*=\s*["']([^"']+)["']/i)?.[1] ?? "GET";
    addRoute(routes, config, match[1], method, "form");
  }

  const apiStringPattern = /["'`](\/api\/[A-Za-z0-9_./:{}-]+)["'`]/g;
  for (const match of html.matchAll(apiStringPattern)) {
    addRoute(routes, config, match[1], "GET", "script");
  }
}

function extractScriptRoutes(
  config: IntelligentSecurityScanConfig,
  source: string,
  routes: Map<string, RouteInventoryItem>
) {
  const routePattern =
    /["'`]((?:https?:\/\/[^"'`\s)]+|\/(?:api|graphql|v\d+|rest|rpc|auth|session|sessions|user|users|account|accounts|profile|profiles|settings|billing|dashboard|workspaces?|organizations?|tenants?)[A-Za-z0-9_./:{}?&=%-]*))["'`]/gi;
  for (const match of source.matchAll(routePattern)) {
    const raw = match[1]?.trim();
    if (!raw || raw.includes("*") || raw.length > 300) continue;
    addRoute(routes, config, raw, "GET", "script");
  }
}

function extractOpenApiRoutes(
  config: IntelligentSecurityScanConfig,
  body: string,
  routes: Map<string, RouteInventoryItem>
) {
  let parsed: any;
  try {
    parsed = JSON.parse(body);
  } catch {
    return;
  }
  const paths = parsed?.paths && typeof parsed.paths === "object" ? parsed.paths : {};
  for (const [route, operations] of Object.entries(paths)) {
    if (!operations || typeof operations !== "object") continue;
    for (const method of Object.keys(operations as Record<string, unknown>)) {
      const upperMethod = method.toUpperCase();
      if (HTTP_METHODS.has(upperMethod)) {
        addRoute(routes, config, route, upperMethod, "openapi");
      }
    }
  }
}

function matchingFixture(
  config: IntelligentSecurityScanConfig,
  item: RouteInventoryItem
): ApiSecurityFixture | undefined {
  return (config.apiFixtures ?? []).find(
    (fixture) =>
      normalizeRoutePath(fixture.route) === item.route &&
      (fixture.method ?? "GET").toUpperCase() === item.method
  );
}

function inferredControls(route: string, method: string): ExpectedSecurityControl[] {
  const lower = route.toLowerCase();
  const controls = new Set<ExpectedSecurityControl>();
  const protectedLike = PROTECTED_PATH_MARKERS.some((marker) => lower.includes(marker));
  if (protectedLike || lower.startsWith("/api/")) controls.add("auth_required");
  if (lower.includes("admin")) controls.add("role_admin_required");
  if (route.includes(":id") && protectedLike) controls.add("object_owner_required");
  if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) controls.add("input_validation");
  return [...controls];
}

function isLikelyScriptAsset(item: RouteInventoryItem) {
  try {
    const pathname = new URL(item.url).pathname.toLowerCase();
    return /\.(?:js|mjs|cjs|json)$/.test(pathname);
  } catch {
    return false;
  }
}

function addDeepHeuristicRoutes(
  config: IntelligentSecurityScanConfig,
  routes: Map<string, RouteInventoryItem>
) {
  for (const route of DEEP_HEURISTIC_ROUTES) {
    addRoute(routes, config, route, "GET", "heuristic");
  }
}

export async function discoverRouteInventory(
  config: IntelligentSecurityScanConfig
): Promise<RouteInventoryItem[]> {
  const routes = new Map<string, RouteInventoryItem>();
  addRoute(routes, config, config.baseUrl, "GET", "base");

  for (const fixture of config.apiFixtures ?? []) {
    addRoute(routes, config, fixture.route, fixture.method ?? "GET", "fixture");
  }

  const base = await probeScoped(config, config.baseUrl, { method: "GET", timeoutMs: 8000 });
  if (base.body) extractHtmlRoutes(config, base.body, routes);

  if (config.scanDepth === "deep") {
    const firstPass = [...routes.values()];

    for (const item of firstPass.filter(isLikelyScriptAsset).slice(0, 20)) {
      const response = await probeScoped(config, item.url, { method: "GET", timeoutMs: 6000 });
      if (response.status && response.status >= 200 && response.status < 300 && response.body) {
        extractScriptRoutes(config, response.body, routes);
      }
    }

    for (const item of firstPass.filter((route) => route.method === "GET" && !isLikelyScriptAsset(route)).slice(0, 25)) {
      if (item.source === "base") continue;
      const response = await probeScoped(config, item.url, { method: "GET", timeoutMs: 5000 });
      if (response.status && response.status >= 200 && response.status < 300 && response.body) {
        extractHtmlRoutes(config, response.body, routes);
        extractScriptRoutes(config, response.body, routes);
      }
    }

    addDeepHeuristicRoutes(config, routes);
  }

  for (const path of ["/openapi.json", "/swagger.json", "/api/openapi.json", "/api/swagger.json"]) {
    const response = await probeScoped(config, toAbsoluteUrl(config.baseUrl, path), {
      method: "GET",
      timeoutMs: 6000,
    });
    if (response.status && response.status >= 200 && response.status < 300 && response.body) {
      extractOpenApiRoutes(config, response.body, routes);
    }
  }

  const limit = config.scanDepth === "deep" ? 150 : config.scanDepth === "baseline" ? 35 : 75;
  return [...routes.values()].slice(0, limit);
}

export function buildRouteContracts(
  config: IntelligentSecurityScanConfig,
  inventory: RouteInventoryItem[]
): RouteSecurityContract[] {
  return inventory
    .map<RouteSecurityContract | null>((item) => {
      const fixture = matchingFixture(config, item);
      const expectedControls = fixture
        ? Array.from(new Set([...(config.expectedControls ?? []), ...(fixture.expectedControls ?? [])]))
        : inferredControls(item.route, item.method);
      if (!expectedControls.length) return null;

      return {
        route: item.route,
        method: item.method,
        source: fixture ? "fixture" : item.source === "base" ? "heuristic" : item.source,
        expectedControls,
        expectedDenyStatuses: fixture?.expectedDenyStatuses ?? [401, 403, 404],
        forbiddenFields: fixture?.forbiddenFields ?? DEFAULT_FORBIDDEN_FIELDS,
        ownerProfile: fixture?.ownerProfile,
        otherProfile: fixture?.otherProfile,
        adminProfile: fixture?.adminProfile,
        lowPrivilegeProfile: fixture?.lowPrivilegeProfile,
        ownerObjectId: fixture?.ownerObjectId,
        otherObjectId: fixture?.otherObjectId,
        confidence: fixture ? "declared" : "heuristic",
      };
    })
    .filter((contract): contract is RouteSecurityContract => !!contract);
}

function contractSuggestionName(contract: RouteSecurityContract) {
  const noun = contract.route
    .split("/")
    .filter(Boolean)
    .filter((part) => part !== ":id")
    .pop();
  const readable = noun
    ? noun
        .replace(/[-_]/g, " ")
        .replace(/\b\w/g, (char) => char.toUpperCase())
    : "API Route";
  return `${readable} access`;
}

function contractSuggestionRationale(contract: RouteSecurityContract) {
  const reasons = new Set<string>();
  if (contract.source === "openapi") reasons.add("OpenAPI route");
  if (contract.source === "script") reasons.add("client-side API reference");
  if (contract.source === "form") reasons.add("HTML form route");
  if (contract.expectedControls.includes("object_owner_required")) reasons.add("object identifier");
  if (contract.expectedControls.includes("role_admin_required")) reasons.add("admin route");
  if (contract.expectedControls.includes("auth_required")) reasons.add("protected route pattern");
  return reasons.size ? [...reasons].join(", ") : "protected route heuristic";
}

function fixtureSuggestionKey(fixture: Pick<ApiSecurityFixture, "route" | "method">) {
  return routeKey(normalizeRoutePath(fixture.route), fixture.method ?? "GET");
}

export function suggestApiSecurityFixtures(
  config: IntelligentSecurityScanConfig,
  inventory: RouteInventoryItem[]
): ApiSecurityFixtureSuggestion[] {
  const existing = new Set((config.apiFixtures ?? []).map(fixtureSuggestionKey));
  const suggestions = new Map<string, ApiSecurityFixtureSuggestion>();
  for (const contract of buildRouteContracts(config, inventory)) {
    const key = fixtureSuggestionKey(contract);
    if (existing.has(key) || contract.confidence === "declared") continue;

    const interesting =
      contract.route.startsWith("/api/") ||
      contract.expectedControls.includes("object_owner_required") ||
      contract.expectedControls.includes("role_admin_required");
    if (!interesting) continue;

    suggestions.set(key, {
      name: contractSuggestionName(contract),
      route: contract.route,
      method: contract.method,
      expectedDenyStatuses: contract.expectedDenyStatuses,
      expectedControls: contract.expectedControls,
      forbiddenFields: contract.forbiddenFields,
      source: contract.source,
      confidence: contract.confidence,
      rationale: contractSuggestionRationale(contract),
      objectIdRequired:
        contract.route.includes(":id") &&
        contract.expectedControls.includes("object_owner_required"),
    });
  }

  return [...suggestions.values()].sort((a, b) => {
    const aObject = a.objectIdRequired ? 0 : 1;
    const bObject = b.objectIdRequired ? 0 : 1;
    if (aObject !== bObject) return aObject - bObject;
    return `${a.method} ${a.route}`.localeCompare(`${b.method} ${b.route}`);
  });
}
