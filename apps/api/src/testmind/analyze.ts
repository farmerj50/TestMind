// apps/api/src/testmind/analyze.ts
import { discoverSite } from "./discover";
import type { Discovery } from "./core/plan";

/**
 * Minimal analyzer: just crawl the site and return Discovery.
 * Kept tiny on purpose to avoid breaking the pipeline.
 */
export async function analyze(baseUrl: string): Promise<Discovery> {
  if (!baseUrl) throw new Error("baseUrl is required");
  // Legacy Discovery contract: apis stayed [] here; B2 captured traffic is consumed by the Brain, not this shape.
  const discovered = await discoverSite(baseUrl);
  return { routes: discovered.routes, forms: discovered.forms, apis: [] };
}

// Back-compat re-export (some files may import discoverSite from here)
export { discoverSite };
