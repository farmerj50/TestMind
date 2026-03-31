import type { SelfHealPayload } from "../../runner/queue.js";

export type AiActionMode = "analyze" | "assist" | "repair" | "autonomous";

export type AiEvidenceArtifact = {
  type:
    | "report"
    | "page-signals"
    | "error-context"
    | "screenshot"
    | "video"
    | "trace"
    | "log"
    | "json"
    | "text"
    | "other";
  path: string;
  label?: string | null;
  excerpt?: string | null;
};

export type AiExecutionScope = {
  projectId: string;
  runId?: string;
  testResultId?: string;
  testCaseId?: string;
  framework?: string | null;
  specPath?: string | null;
};

export type AiExecutionFailure = {
  stdout?: string;
  stderr?: string;
  message?: string | null;
  testTitle?: string | null;
};

export type AiExecutionEvidence = {
  reportSnippet?: string;
  pageSignalsSnippet?: string;
  errorContextSnippet?: string;
  structuredSummary?: string;
  artifacts: AiEvidenceArtifact[];
  failureClasses: string[];
};

export type AiExecutionContext = {
  mode: AiActionMode;
  job: SelfHealPayload;
  scope: AiExecutionScope;
  repoRoot: string;
  repoRelativePath: string;
  repoAbsolutePath: string;
  runSpecPath?: string;
  specContent?: string;
  selectedTestSnippet?: string;
  failure: AiExecutionFailure;
  evidence: AiExecutionEvidence;
};

export type AiActionSnapshot = {
  framework?: string | null;
  specPath: string;
  testTitle?: string | null;
  failureMessage?: string | null;
  stdoutSnippet: string;
  stderrSnippet: string;
  specSnippet: string;
  artifactCount?: number;
  failureClasses?: string[];
};

export type AiAnalyzeActionResult = {
  kind: "analyze";
  mode: "analyze";
  actionId: string;
  status: "allowed" | "blocked";
  allowed: boolean;
  reasons: string[];
  frameworkId?: string | null;
  targetScope: "run" | "spec" | "testcase";
  rerunIntent?: "ai-rerun" | null;
  context: AiExecutionContext;
  snapshot: AiActionSnapshot;
};

export type AiAssistActionResult = {
  kind: "assist";
  mode: "assist";
  actionId: string;
  status: "allowed" | "blocked";
  allowed: boolean;
  reasons: string[];
  frameworkId?: string | null;
  targetScope: "run" | "spec" | "testcase";
  rerunIntent?: "ai-rerun" | null;
  context: AiExecutionContext;
  snapshot: AiActionSnapshot;
  capabilities: {
    canAutonomouslyRepair: boolean;
    canUseStructuredPatch: boolean;
  };
};

export type AiRepairActionResult = {
  kind: "repair";
  mode: "repair";
  actionId: string;
  status: "allowed" | "blocked";
  allowed: boolean;
  reasons: string[];
  frameworkId?: string | null;
  targetScope: "run" | "spec" | "testcase";
  rerunIntent?: "ai-rerun" | null;
  context: AiExecutionContext;
  snapshot: AiActionSnapshot;
  capabilities: {
    canAutonomouslyRepair: boolean;
    canUseStructuredPatch: boolean;
    evidenceArtifactCount: number;
  };
};
