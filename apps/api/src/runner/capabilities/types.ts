/**
 * Standard interface for all operator capabilities.
 *
 * Each capability executor receives a CapabilityInput and returns
 * a CapabilityOutput. The dispatcher in index.ts routes based on
 * the `capability` field of an OperatorStep.
 */

export interface CapabilityInput {
  /** Capability-specific action verb: get, post, run, read, navigate, etc. */
  action: string;
  /** Primary target: URL, file path, shell command, git ref, etc. */
  target?: string;
  /** Arbitrary extra parameters for the action */
  params?: Record<string, unknown>;
}

export interface CapabilityArtifact {
  type: 'screenshot' | 'dom' | 'console' | 'network' | 'patch' | 'report' | 'har';
  /** Base64 or text content */
  content: string;
  mimeType?: string;
  label?: string;
}

export interface CapabilityOutput {
  success: boolean;
  /** Structured result data from the action */
  data?: unknown;
  error?: string;
  /** Optional artifacts produced (screenshots, DOM snapshots, etc.) */
  artifacts?: CapabilityArtifact[];
}

/** Context passed through to every capability executor */
export interface ExecutionContext {
  jobId: string;
  taskId: string;
  projectId: string;
  /** Base URL of the app under test (when relevant) */
  baseUrl?: string;
  /** Working directory for terminal/git/filesystem operations */
  workDir?: string;
}
