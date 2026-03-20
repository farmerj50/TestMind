import type { SelfHealPayload } from "../../runner/queue.js";

export type AiActionMode = "analyze" | "assist" | "autonomous";

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

export type AiExecutionContext = {
  mode: AiActionMode;
  job: SelfHealPayload;
  scope: AiExecutionScope;
  repoRoot: string;
  repoRelativePath: string;
  repoAbsolutePath: string;
  runSpecPath?: string;
  specContent?: string;
  failure: AiExecutionFailure;
};
