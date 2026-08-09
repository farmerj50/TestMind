import { createHash } from "node:crypto";
import type { CrawlMetadata } from "./types.js";

export function crawlFingerprint(metadata: Pick<CrawlMetadata, "routes" | "forms" | "apis">): string {
  const stable = JSON.stringify({
    routes: [...metadata.routes].sort(),
    forms: metadata.forms
      .map((f) => `${f.action}:${f.method}:${[...f.fields].sort().join(",")}`)
      .sort(),
    apis: [...metadata.apis].sort(),
  });
  return createHash("sha256").update(stable).digest("hex").slice(0, 16);
}
