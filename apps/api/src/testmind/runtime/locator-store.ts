export type LocatorBucket = "fields" | "buttons" | "links" | "locators";

export type LocatorEntry = {
  selector: string;
  semantic?: string;
  bucket?: LocatorBucket;
};

export type LocatorPage = {
  identity?: { kind: "role" | "text" | "locator"; selector?: string; role?: string; name?: string; text?: string };
  fields?: Record<string, string>;
  buttons?: Record<string, string>;
  links?: Record<string, string>;
  locators?: Record<string, string>;
};

export type LocatorStore = {
  version?: number;
  pages?: Record<string, LocatorPage>;
  nav?: Record<string, string>;
  locatorFallbacks?: Record<string, Record<LocatorBucket, Record<string, LocatorFallbackEntry>>>;
};

export type LocatorFallbackEntry = {
  primary?: string;
  fallbacks?: string[];
  metadata?: {
    urlPattern?: string;
    uniqueAnchor?: string;
  };
  updatedBy?: string;
  updatedAt?: string;
};

export function normalizeSharedSteps(raw: unknown): LocatorStore {
  if (!raw || typeof raw !== "object") return { pages: {} };
  const obj = raw as Record<string, any>;
  if (obj.pages && typeof obj.pages === "object") {
    return {
      version: typeof obj.version === "number" ? obj.version : undefined,
      nav: normalizeMap(obj.nav),
      locatorFallbacks: normalizeLocatorFallbacks(obj.locatorFallbacks),
      pages: Object.entries(obj.pages).reduce<Record<string, LocatorPage>>((acc, [pageKey, pageValue]) => {
        acc[pageKey] = normalizePage(pageValue);
        return acc;
      }, {}),
    };
  }
  if (obj.locators && typeof obj.locators === "object") {
    return {
      nav: normalizeMap(obj.nav),
      locatorFallbacks: normalizeLocatorFallbacks(obj.locatorFallbacks),
      pages: Object.entries(obj.locators).reduce((acc, [pageKey, locators]) => {
        acc[pageKey] = { locators: normalizeMap(locators) };
        return acc;
      }, {} as Record<string, LocatorPage>),
    };
  }
  return { pages: {} };
}

function normalizePage(value: unknown): LocatorPage {
  if (!value || typeof value !== "object") return {};
  const page = value as Record<string, any>;
  return {
    identity: page.identity,
    fields: normalizeMap(page.fields),
    buttons: normalizeMap(page.buttons),
    links: normalizeMap(page.links),
    locators: normalizeMap(page.locators),
  };
}

function normalizeMap(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const map = value as Record<string, unknown>;
  const normalized: Record<string, string> = {};
  for (const [key, val] of Object.entries(map)) {
    if (typeof val === "string" && val.trim()) {
      const cleaned = normalizeSelectorValue(val);
      if (cleaned) normalized[key] = cleaned;
    }
  }
  return Object.keys(normalized).length ? normalized : undefined;
}

function normalizeLocatorFallbacks(value: unknown): LocatorStore["locatorFallbacks"] {
  if (!value || typeof value !== "object") return undefined;
  const pages = value as Record<string, unknown>;
  const out: NonNullable<LocatorStore["locatorFallbacks"]> = {};
  for (const [pageKey, pageValue] of Object.entries(pages)) {
    if (!pageValue || typeof pageValue !== "object") continue;
    const pageObj = pageValue as Record<string, unknown>;
    const bucketOut = {} as Record<LocatorBucket, Record<string, LocatorFallbackEntry>>;
    for (const bucket of ["fields", "buttons", "links", "locators"] as const) {
      const bucketValue = pageObj[bucket];
      if (!bucketValue || typeof bucketValue !== "object") continue;
      const nameMap = bucketValue as Record<string, unknown>;
      const normalizedEntries: Record<string, LocatorFallbackEntry> = {};
      for (const [name, rawEntry] of Object.entries(nameMap)) {
        if (!rawEntry || typeof rawEntry !== "object") continue;
        const entry = rawEntry as Record<string, unknown>;
        const primary = typeof entry.primary === "string" ? normalizeSelectorValue(entry.primary) : null;
        const fallbacks = Array.isArray(entry.fallbacks)
          ? entry.fallbacks
              .map((item) => (typeof item === "string" ? normalizeSelectorValue(item) : null))
              .filter((item): item is string => !!item)
          : [];
        if (!primary && !fallbacks.length) continue;
        const metadataRaw = entry.metadata && typeof entry.metadata === "object"
          ? (entry.metadata as Record<string, unknown>)
          : undefined;
        const metadata = metadataRaw
          ? {
              urlPattern:
                typeof metadataRaw.urlPattern === "string" && metadataRaw.urlPattern.trim()
                  ? metadataRaw.urlPattern.trim()
                  : undefined,
              uniqueAnchor:
                typeof metadataRaw.uniqueAnchor === "string" && metadataRaw.uniqueAnchor.trim()
                  ? metadataRaw.uniqueAnchor.trim()
                  : undefined,
            }
          : undefined;
        normalizedEntries[name] = {
          primary: primary ?? undefined,
          fallbacks,
          metadata,
          updatedBy: typeof entry.updatedBy === "string" ? entry.updatedBy : undefined,
          updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt : undefined,
        };
      }
      if (Object.keys(normalizedEntries).length) {
        bucketOut[bucket] = normalizedEntries;
      }
    }
    if (Object.keys(bucketOut).length) {
      out[pageKey] = bucketOut;
    }
  }
  return Object.keys(out).length ? out : undefined;
}

export function normalizeSelectorValue(value: string): string | null {
  let cleaned = value.trim();
  if (!cleaned) return null;
  cleaned = cleaned.replace(/\s+to be visible$/i, "").trim();

  const locatorMatch = cleaned.match(/locator\(\s*['"`]([^'"`]+)['"`]\s*\)/i);
  if (locatorMatch?.[1]) return locatorMatch[1].trim();

  const textMatch = cleaned.match(/getByText\(\s*['"`]([^'"`]+)['"`]\s*\)/i);
  if (textMatch?.[1]) return `text=${textMatch[1].trim()}`;

  const labelMatch = cleaned.match(/getByLabel\(\s*['"`]([^'"`]+)['"`]\s*\)/i);
  if (labelMatch?.[1]) return `text=${labelMatch[1].trim()}`;

  const roleMatch = cleaned.match(/getByRole\(\s*['"`]([^'"`]+)['"`]\s*,\s*\{\s*name:\s*['"`]([^'"`]+)['"`]\s*\}\s*\)/i);
  if (roleMatch?.[1] && roleMatch?.[2]) {
    return `role=${roleMatch[1].trim()}[name="${roleMatch[2].trim()}"]`;
  }

  if (/^text=locator\(/i.test(cleaned)) {
    const inner = cleaned.match(/text=locator\(\s*['"`]([^'"`]+)['"`]\s*\)/i);
    if (inner?.[1]) return inner[1].trim();
  }

  return cleaned;
}

function normalizePathKey(path: string): string {
  if (!path) return "/";
  try {
    const url = new URL(path, "http://localhost");
    const pathname = url.pathname || "/";
    const search = url.search || "";
    return `${pathname}${search}` || "/";
  } catch {
    return path.startsWith("/") ? path : `/${path}`;
  }
}

function matchesPrefix(route: string, prefix: string): boolean {
  const normalizedPrefix = prefix.endsWith("/") ? prefix : `${prefix}/`;
  return route === prefix || route.startsWith(normalizedPrefix);
}

function pathMatchesPattern(path: string, pattern: string): boolean {
  const candidate = pattern.trim();
  if (!candidate) return true;
  if (candidate.startsWith("/") || candidate.startsWith("http://") || candidate.startsWith("https://")) {
    const normalizedPattern = normalizePathKey(candidate.split("#")[0]);
    if (normalizedPattern.includes("*")) {
      const escaped = normalizedPattern
        .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*");
      return new RegExp(`^${escaped}$`).test(path);
    }
    return path === normalizedPattern || matchesPrefix(path, normalizedPattern);
  }
  try {
    return new RegExp(candidate).test(path);
  } catch {
    return false;
  }
}

function normalizeIdentitySelectorFromPage(page: LocatorPage | undefined): string | undefined {
  if (!page) return undefined;
  const identity = page.identity;
  if (identity?.kind === "locator" && typeof identity.selector === "string") {
    return normalizeSelectorValue(identity.selector) ?? undefined;
  }
  const candidate =
    page.locators?.pageIdentity ??
    page.locators?.identity ??
    page.locators?.page ??
    page.locators?.root;
  if (!candidate) return undefined;
  return normalizeSelectorValue(candidate) ?? undefined;
}

function anchorMatchesPageIdentity(page: LocatorPage | undefined, uniqueAnchor?: string): boolean {
  if (!uniqueAnchor) return true;
  const normalizedAnchor = normalizeSelectorValue(uniqueAnchor);
  if (!normalizedAnchor) return true;
  const pageIdentitySelector = normalizeIdentitySelectorFromPage(page);
  if (!pageIdentitySelector) return false;
  return pageIdentitySelector === normalizedAnchor;
}

export function bestPageKey(store: LocatorStore, path: string): string | null {
  const pages = store.pages ?? {};
  const key = normalizePathKey(path.split("?")[0]);
  if (pages[key]) return key;
  let best: string | null = null;
  for (const candidate of Object.keys(pages)) {
    if (candidate === "/" && key !== "/") continue;
    if (matchesPrefix(key, candidate) || key === candidate) {
      if (!best || candidate.length > best.length) {
        best = candidate;
      }
    }
  }
  return best;
}

export function resolveLocator(
  store: LocatorStore,
  pagePath: string,
  bucket: LocatorBucket,
  name: string
): {
  selector?: string;
  pageKey?: string;
  resolutionSource?: "nav" | "page" | "fallback-primary" | "fallback";
  fallbackIndex?: number;
  attemptedSelectors?: string[];
  identityMatched?: boolean;
} {
  if (pagePath === "__global_nav__") {
    const selector = store.nav?.[name];
    if (selector) {
      return {
        selector,
        pageKey: "__global_nav__",
        resolutionSource: "nav",
        fallbackIndex: -1,
        attemptedSelectors: [selector],
        identityMatched: true,
      };
    }
    return { pageKey: "__global_nav__", identityMatched: true };
  }
  const pageKey = bestPageKey(store, pagePath);
  if (!pageKey) return {};
  const normalizedPath = normalizePathKey(pagePath.split("#")[0]);
  const page = store.pages?.[pageKey];
  const targetFromPage =
    bucket === "fields"
      ? page?.fields?.[name]
      : bucket === "buttons"
      ? page?.buttons?.[name]
      : bucket === "links"
      ? page?.links?.[name]
      : page?.locators?.[name];
  const fallbackEntry = store.locatorFallbacks?.[pageKey]?.[bucket]?.[name];
  const fallbackIdentityMatched = fallbackEntry?.metadata?.urlPattern
    ? pathMatchesPattern(normalizedPath, fallbackEntry.metadata.urlPattern)
    : true;
  const fallbackAnchorMatched = anchorMatchesPageIdentity(page, fallbackEntry?.metadata?.uniqueAnchor);
  const fallbackAllowed = fallbackIdentityMatched && fallbackAnchorMatched;
  const candidates = [
    targetFromPage,
    ...(fallbackAllowed ? [fallbackEntry?.primary, ...(fallbackEntry?.fallbacks ?? [])] : []),
  ].filter((value): value is string => !!value);
  const dedupedCandidates = Array.from(new Set(candidates));
  const selector = dedupedCandidates[0];
  if (selector) {
    let resolutionSource: "page" | "fallback-primary" | "fallback" = "page";
    let fallbackIndex = -1;
    if (!targetFromPage && fallbackEntry?.primary && selector === fallbackEntry.primary) {
      resolutionSource = "fallback-primary";
      fallbackIndex = 0;
    } else if (fallbackEntry?.fallbacks?.length && fallbackEntry.fallbacks.includes(selector)) {
      resolutionSource = "fallback";
      fallbackIndex = fallbackEntry.fallbacks.indexOf(selector);
    }
    return {
      selector,
      pageKey,
      resolutionSource,
      fallbackIndex,
      attemptedSelectors: dedupedCandidates,
      identityMatched: fallbackAllowed,
    };
  }
  return { pageKey, identityMatched: fallbackAllowed };
}
