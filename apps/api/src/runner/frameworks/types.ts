export type FrameworkId =
  | "playwright-ts"
  | "cypress-js"
  | "cucumber-js"
  | "junit"
  | "postman"
  | "appium-js"
  | "xctest"
  | "jest"
  | "vitest";

export type FailureKind =
  | "assertion"
  | "locator"
  | "timeout"
  | "navigation"
  | "network"
  | "http"
  | "schema"
  | "env"
  | "auth"
  | "crash"
  | "unknown";

export type PatchTargetKind =
  | "spec"
  | "step-definition"
  | "test-helper"
  | "fixture"
  | "collection"
  | "environment"
  | "source"
  | "config"
  | "unknown";

export interface NormalizedFailureArtifact {
  type: "screenshot" | "video" | "trace" | "log" | "junitXml" | "json";
  path?: string;
  url?: string;
  label?: string;
}

export interface NormalizedFailureLocation {
  file?: string;
  line?: number;
  column?: number;
  testFile?: string;
  sourceFile?: string;
  className?: string;
  methodName?: string;
  scenarioName?: string;
  stepText?: string;
  requestName?: string;
  endpoint?: string;
  httpMethod?: string;
}

export interface NormalizedFailure {
  framework: FrameworkId;
  runId: string;
  status: "failed" | "passed" | "skipped";
  suiteName?: string;
  testName: string;
  message?: string;
  stack?: string;
  kind: FailureKind;
  location: NormalizedFailureLocation;
  artifacts: NormalizedFailureArtifact[];
  suggestedPatchTargets: PatchTargetKind[];
  raw?: Record<string, unknown>;
}

export interface FrameworkParseInput {
  runId: string;
  framework: FrameworkId | string;
  resultsPath?: string;
  rawReport?: unknown;
  stdout?: string;
  stderr?: string;
  files?: string[];
  metadata?: Record<string, unknown>;
}

export interface FrameworkFailureAdapter {
  framework: FrameworkId;
  canParse(input: {
    framework: FrameworkId;
    files?: string[];
    metadata?: Record<string, unknown>;
    rawReport?: unknown;
  }): boolean;
  parseFailures(input: FrameworkParseInput & { framework: FrameworkId }): Promise<NormalizedFailure[]>;
}

export function normalizeFrameworkId(value: string): FrameworkId | null {
  const normalized = value.trim().toLowerCase();
  switch (normalized) {
    case "playwright":
    case "playwright-ts":
      return "playwright-ts";
    case "cypress":
    case "cypress-js":
      return "cypress-js";
    case "cucumber":
    case "cucumber-js":
      return "cucumber-js";
    case "postman":
    case "newman":
      return "postman";
    case "junit":
      return "junit";
    case "appium":
    case "appium-js":
      return "appium-js";
    case "xctest":
      return "xctest";
    case "jest":
      return "jest";
    case "vitest":
      return "vitest";
    default:
      return null;
  }
}
