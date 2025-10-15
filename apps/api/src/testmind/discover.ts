// apps/api/src/testmind/discover.ts

// Pull types from core (note the .js extension)
import type { Discovery } from "./core/plan.js";

// Use Node 18+ global fetch (no undici needed)
async function fetchHtml(url: string): Promise<string> {
  const res = await fetch(url, { method: "GET" });
  return await res.text();
}

function extractHrefs(html: string): string[] {
  const rx = /<a\s+[^>]*href=["']([^"']+)["']/gi;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = rx.exec(html))) out.push(m[1]);
  return out;
}

function normalize(base: string, href: string): string | null {
  try {
    const u = new URL(href, base);
    // same-origin only
    if (u.origin !== new URL(base).origin) return null;
    return u.pathname || "/";
  } catch {
    return null;
  }
}

/**
 * Crawl same-origin links starting at baseUrl and return unique paths.
 */
export async function crawlRoutes(baseUrl: string, maxPages = 80): Promise<string[]> {
  const seenAbs = new Set<string>();
  const q: string[] = [baseUrl];

  while (q.length && seenAbs.size < maxPages) {
    const url = q.shift()!;
    if (seenAbs.has(url)) continue;
    seenAbs.add(url);

    let html = "";
    try {
      html = await fetchHtml(url);
    } catch {
      continue;
    }

    for (const href of extractHrefs(html)) {
      const path = normalize(baseUrl, href);
      if (!path) continue;
      const abs = new URL(path, baseUrl).toString();
      if (!seenAbs.has(abs)) q.push(abs);
    }
  }

  // Convert absolute URLs to pathnames and de-dupe
  const paths = Array.from(seenAbs).map((u) => {
    try {
      return new URL(u).pathname || "/";
    } catch {
      return "/";
    }
  });
  return Array.from(new Set(paths));
}

/**
 * Lightweight site discovery: routes now, stubs for forms/apis.
 * (Using Discovery type here removes the TS6133 warning.)
 */
export async function discoverSite(baseUrl: string): Promise<Discovery> {
  const routes = await crawlRoutes(baseUrl, 120);
  return {
    routes,
    forms: [], // TODO: parse basic form metadata if needed
    apis: [],  // TODO: add API capture if you instrument the app
  };
}
