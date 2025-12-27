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
};

export function normalizeSharedSteps(raw: unknown): LocatorStore {
  if (!raw || typeof raw !== "object") return { pages: {} };
  const obj = raw as Record<string, any>;
  if (obj.pages && typeof obj.pages === "object") {
    return {
      version: typeof obj.version === "number" ? obj.version : undefined,
      pages: Object.entries(obj.pages).reduce<Record<string, LocatorPage>>((acc, [pageKey, pageValue]) => {
        acc[pageKey] = normalizePage(pageValue);
        return acc;
      }, {}),
    };
  }
  if (obj.locators && typeof obj.locators === "object") {
    return {
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

  const inputNameMatch = cleaned.match(/input\[name=(?:"([^"]+)"|'([^']+)')\]/i);
  const inputName = inputNameMatch?.[1] ?? inputNameMatch?.[2];
  if (inputName && /\s/.test(inputName)) {
    return `text=${inputName.trim()}`;
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
): { selector?: string; pageKey?: string } {
  const pageKey = bestPageKey(store, pagePath);
  if (!pageKey) return {};
  const page = store.pages?.[pageKey];
  const target =
    bucket === "fields"
      ? page?.fields?.[name]
      : bucket === "buttons"
      ? page?.buttons?.[name]
      : bucket === "links"
      ? page?.links?.[name]
      : page?.locators?.[name];
  return { selector: target, pageKey };
}
