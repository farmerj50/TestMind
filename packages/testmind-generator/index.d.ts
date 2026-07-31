export type GenerateConfig = {
  repoPath: string;
  outRoot: string;
  baseUrl: string;
  adapterId: string;
  include?: string;
  exclude?: string;
  maxRoutes?: number;
  credentials?: { email?: string; password?: string };
  sharedSteps?: Record<string, unknown>;
};

export type CrawlMetadata = {
  routes: string[];
  forms: Array<{ action: string; method: string; fields: string[] }>;
  apis: string[];
  detectedFramework?: string;
  authRequired: boolean;
  crawlDepth: number;
  pageCount: number;
  fingerprint?: string;
};

export type GenerateResult = {
  specFiles: Array<{ path: string; content: string }>;
  metadata: CrawlMetadata;
  outRoot: string;
};

export type SpecVersionHeader = {
  version: string;
  generated: string;
  target: string;
  framework?: string;
  confidence?: number;
  crawlDepth?: number;
  specVersion: number;
};

export declare function crawlFingerprint(
  metadata: Pick<CrawlMetadata, "routes" | "forms" | "apis">
): string;

export declare function buildSpecVersionHeader(
  opts: Omit<SpecVersionHeader, "version" | "generated" | "specVersion">
): string;

export declare function injectSpecHeader(
  content: string,
  opts: Omit<SpecVersionHeader, "version" | "generated" | "specVersion">
): string;
