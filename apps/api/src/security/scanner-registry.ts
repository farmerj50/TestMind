import type { SecurityScanPayload } from "../runner/queue.js";
import { runIntelligentValidation } from "./modules/intelligent-validation.js";
import { runAnomalyBaseline } from "./modules/anomaly-baseline.js";
import { runGraphQLAudit } from "./modules/graphql-audit.js";
import { runOpenApiScan } from "./modules/openapi-scan.js";
import { runRaceConditionScan } from "./modules/race-condition.js";
import { runJwtAnalysis } from "./modules/jwt-analyzer.js";
import { runIdorScan } from "./modules/idor-engine.js";
import { runNucleiScan } from "./modules/nuclei-scan.js";
import { runZapScan } from "./modules/zap-scan.js";
import { runJsEndpointExtraction } from "./modules/js-endpoint-extractor.js";
import { runBusinessLogicScan } from "./modules/business-logic.js";
import { runCorsAudit } from "./modules/cors-audit.js";
import { runPerfBaseline } from "./modules/perf-baseline.js";
import { runMobileScan } from "./modules/mobile-scan.js";
import { isOpenSourceToolSelected, type OpenSourceSecurityToolId } from "./open-source-tools.js";
import type { ParsedApiSpec } from "./openapi-parser.js";
import type { ProbeScope } from "./http-client.js";
import type {
  AuthMatrixResult,
  IntelligentSecurityScanConfig,
  RouteBaselineSnapshot,
  RouteSecurityContract,
  SecurityAgentFinding,
  SecurityAuthProfile,
} from "./types.js";

export type SecurityScannerCategory = "passive" | "active" | "code" | "api";
export type SecurityScannerRisk = "low" | "medium" | "high";
export type SecurityScannerPhase =
  | "intelligent_validation"
  | "graphql_audit"
  | "openapi_scan"
  | "js_analysis"
  | "open_source_tools"
  | "advanced_analysis"
  | "business_logic_cors"
  | "mobile_scan"
  | "anomaly_baseline";

export type SecurityScannerContext = {
  payload: SecurityScanPayload;
  payloadWithAuth: SecurityScanPayload & { authProfiles?: SecurityAuthProfile[] };
  scope: ProbeScope;
  authProfiles: SecurityAuthProfile[];
  intelligentConfig: IntelligentSecurityScanConfig;
  validationConfig: IntelligentSecurityScanConfig;
  routeContracts: RouteSecurityContract[];
  apiSpec?: ParsedApiSpec | null;
};

export type SecurityScannerRunResult = {
  findings: SecurityAgentFinding[];
  metadata?: Record<string, unknown>;
};

export type SecurityScannerModule = {
  id: string;
  name: string;
  phase: SecurityScannerPhase;
  category: SecurityScannerCategory;
  risk: SecurityScannerRisk;
  source?: "testmind" | "open_source";
  toolId?: OpenSourceSecurityToolId;
  supports: (ctx: SecurityScannerContext) => boolean;
  run: (ctx: SecurityScannerContext) => Promise<SecurityScannerRunResult>;
  continueOnError?: boolean;
};

export type SecurityScannerExecutionResult = {
  scannerId: string;
  scannerName: string;
  phase: SecurityScannerPhase;
  category: SecurityScannerCategory;
  risk: SecurityScannerRisk;
  source: "testmind" | "open_source";
  toolId?: OpenSourceSecurityToolId;
  durationMs: number;
  findings: SecurityAgentFinding[];
  metadata?: Record<string, unknown>;
  error?: string;
};

export type AnomalyBaselineScannerMetadata = {
  snapshots: RouteBaselineSnapshot[];
  authMatrix: AuthMatrixResult[];
};

function findingsOnly(findings: SecurityAgentFinding[]): SecurityScannerRunResult {
  return { findings };
}

export const builtInSecurityScanners: SecurityScannerModule[] = [
  {
    id: "intelligent-validation",
    name: "Intelligent API validation",
    phase: "intelligent_validation",
    category: "api",
    risk: "medium",
    source: "testmind",
    supports: (ctx) => Boolean(ctx.validationConfig.apiFixtures?.length),
    run: async (ctx) => findingsOnly(await runIntelligentValidation(ctx.validationConfig)),
    continueOnError: true,
  },
  {
    id: "graphql-audit",
    name: "GraphQL audit",
    phase: "graphql_audit",
    category: "api",
    risk: "medium",
    source: "testmind",
    supports: () => true,
    run: async (ctx) => findingsOnly((await runGraphQLAudit(ctx.payloadWithAuth)) as SecurityAgentFinding[]),
    continueOnError: true,
  },
  {
    id: "openapi-scan",
    name: "OpenAPI scan",
    phase: "openapi_scan",
    category: "api",
    risk: "medium",
    source: "testmind",
    supports: (ctx) => Boolean(ctx.apiSpec),
    run: async (ctx) => findingsOnly((await runOpenApiScan(ctx.apiSpec!, ctx.payload.baseUrl, ctx.authProfiles, ctx.scope)) as SecurityAgentFinding[]),
    continueOnError: true,
  },
  {
    id: "js-endpoint-extractor",
    name: "JavaScript endpoint extraction",
    phase: "js_analysis",
    category: "passive",
    risk: "low",
    source: "testmind",
    supports: () => true,
    run: async (ctx) => {
      const result = await runJsEndpointExtraction(ctx.payload.baseUrl, ctx.authProfiles, ctx.scope);
      return {
        findings: result.findings as SecurityAgentFinding[],
        metadata: {
          discoveredEndpoints: result.discoveredEndpoints,
          discoveredEndpointCount: result.discoveredEndpoints.length,
        },
      };
    },
    continueOnError: true,
  },
  {
    id: "jwt-analyzer",
    name: "JWT analyzer",
    phase: "advanced_analysis",
    category: "api",
    risk: "low",
    source: "testmind",
    supports: () => true,
    run: async (ctx) => findingsOnly((await runJwtAnalysis(ctx.payload.baseUrl, ctx.authProfiles, ctx.scope)) as SecurityAgentFinding[]),
    continueOnError: true,
  },
  {
    id: "idor-engine",
    name: "IDOR engine",
    phase: "advanced_analysis",
    category: "active",
    risk: "medium",
    source: "testmind",
    supports: () => true,
    run: async (ctx) => findingsOnly((await runIdorScan(ctx.payload.baseUrl, ctx.authProfiles, ctx.scope)) as SecurityAgentFinding[]),
    continueOnError: true,
  },
  {
    id: "race-condition",
    name: "Race condition scanner",
    phase: "advanced_analysis",
    category: "active",
    risk: "high",
    source: "testmind",
    supports: () => true,
    run: async (ctx) => findingsOnly((await runRaceConditionScan(ctx.payload.baseUrl, ctx.authProfiles, ctx.scope)) as SecurityAgentFinding[]),
    continueOnError: true,
  },
  {
    id: "nuclei",
    name: "Nuclei scanner",
    phase: "open_source_tools",
    category: "active",
    risk: "medium",
    source: "open_source",
    toolId: "nuclei",
    supports: (ctx) => isOpenSourceToolSelected(ctx.payload.openSourceToolIds, "nuclei"),
    run: async (ctx) => findingsOnly((await runNucleiScan(ctx.payload.baseUrl, ctx.authProfiles, ctx.payload.scanDepth ?? "standard")) as SecurityAgentFinding[]),
    continueOnError: true,
  },
  {
    id: "zap-baseline",
    name: "OWASP ZAP baseline",
    phase: "open_source_tools",
    category: "passive",
    risk: "low",
    source: "open_source",
    toolId: "zap-baseline",
    supports: (ctx) => isOpenSourceToolSelected(ctx.payload.openSourceToolIds, "zap-baseline"),
    run: async (ctx) =>
      findingsOnly(
        await runZapScan(
          ctx.payload.baseUrl,
          ctx.authProfiles,
          ctx.payload.scanDepth ?? "standard",
          ctx.scope,
          "baseline"
        )
      ),
    continueOnError: true,
  },
  {
    id: "zap-full",
    name: "OWASP ZAP full active",
    phase: "open_source_tools",
    category: "active",
    risk: "high",
    source: "open_source",
    toolId: "zap-full",
    supports: (ctx) =>
      isOpenSourceToolSelected(ctx.payload.openSourceToolIds, "zap-full") &&
      ctx.payload.scanDepth === "deep" &&
      ctx.payload.enableActive === true &&
      ctx.payload.safeMode === false &&
      ctx.payload.approvalGranted === true,
    run: async (ctx) =>
      findingsOnly(
        await runZapScan(
          ctx.payload.baseUrl,
          ctx.authProfiles,
          ctx.payload.scanDepth ?? "deep",
          ctx.scope,
          "full"
        )
      ),
    continueOnError: true,
  },
  {
    id: "business-logic",
    name: "Business logic scanner",
    phase: "business_logic_cors",
    category: "active",
    risk: "high",
    source: "testmind",
    supports: () => true,
    run: async (ctx) => findingsOnly((await runBusinessLogicScan(ctx.payload.baseUrl, ctx.authProfiles, ctx.scope)) as SecurityAgentFinding[]),
    continueOnError: true,
  },
  {
    id: "cors-audit",
    name: "CORS audit",
    phase: "business_logic_cors",
    category: "api",
    risk: "low",
    source: "testmind",
    supports: () => true,
    run: async (ctx) => findingsOnly((await runCorsAudit(ctx.payload.baseUrl, ctx.authProfiles, ctx.scope)) as SecurityAgentFinding[]),
    continueOnError: true,
  },
  {
    id: "perf-baseline",
    name: "Performance baseline",
    phase: "mobile_scan",
    category: "passive",
    risk: "low",
    source: "testmind",
    supports: () => true,
    run: async (ctx) => findingsOnly((await runPerfBaseline(ctx.payload.baseUrl, ctx.authProfiles, ctx.scope)) as SecurityAgentFinding[]),
    continueOnError: true,
  },
  {
    id: "mobile-scan",
    name: "Mobile scanner",
    phase: "mobile_scan",
    category: "active",
    risk: "medium",
    source: "testmind",
    supports: () => true,
    run: async (ctx) => findingsOnly((await runMobileScan(ctx.payload.baseUrl, ctx.authProfiles, ctx.scope)) as SecurityAgentFinding[]),
    continueOnError: true,
  },
  {
    id: "anomaly-baseline",
    name: "Anomaly baseline",
    phase: "anomaly_baseline",
    category: "api",
    risk: "medium",
    source: "testmind",
    supports: (ctx) => ctx.routeContracts.length > 0,
    run: async (ctx) => {
      const result = await runAnomalyBaseline(ctx.intelligentConfig, ctx.routeContracts);
      return {
        findings: result.findings,
        metadata: {
          snapshots: result.snapshots,
          authMatrix: result.authMatrix,
        } satisfies AnomalyBaselineScannerMetadata,
      };
    },
    continueOnError: true,
  },
];

export function securityScannersForPhase(ctx: SecurityScannerContext, phase: SecurityScannerPhase) {
  return builtInSecurityScanners.filter((scanner) => scanner.phase === phase && scanner.supports(ctx));
}

export async function runSecurityScannerPhase(
  ctx: SecurityScannerContext,
  phase: SecurityScannerPhase
): Promise<SecurityScannerExecutionResult[]> {
  const scanners = securityScannersForPhase(ctx, phase);
  return Promise.all(
    scanners.map(async (scanner) => {
      const started = Date.now();
      try {
        const result = await scanner.run(ctx);
        return {
          scannerId: scanner.id,
          scannerName: scanner.name,
          phase: scanner.phase,
          category: scanner.category,
          risk: scanner.risk,
          source: scanner.source ?? "testmind",
          toolId: scanner.toolId,
          durationMs: Date.now() - started,
          findings: result.findings,
          metadata: result.metadata,
        };
      } catch (err: any) {
        if (!scanner.continueOnError) throw err;
        const error = err?.message ?? String(err);
        console.warn(`[security-worker] ${scanner.name} error:`, error);
        return {
          scannerId: scanner.id,
          scannerName: scanner.name,
          phase: scanner.phase,
          category: scanner.category,
          risk: scanner.risk,
          source: scanner.source ?? "testmind",
          toolId: scanner.toolId,
          durationMs: Date.now() - started,
          findings: [],
          metadata: { error },
          error,
        };
      }
    })
  );
}

export function findingsFromScannerResults(results: SecurityScannerExecutionResult[]) {
  return results.flatMap((result) => result.findings);
}

export function scannerMetadata<T extends Record<string, unknown>>(
  results: SecurityScannerExecutionResult[],
  scannerId: string
): T | undefined {
  return results.find((result) => result.scannerId === scannerId)?.metadata as T | undefined;
}
