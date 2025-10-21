// apps/api/src/testmind/analyze.ts
import { discoverSite } from "./discover.js";
import type { Discovery } from "./core/plan.js";

/**
 * Minimal analyzer: just crawl the site and return Discovery.
 * Kept tiny on purpose to avoid breaking the pipeline.
 */
export async function analyze(baseUrl: string): Promise<Discovery> {
  if (!baseUrl) throw new Error("baseUrl is required");
  return await discoverSite(baseUrl);
}

// Back-compat re-export (some files may import discoverSite from here)
export { discoverSite };
