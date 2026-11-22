export type ValueType = 'string' | 'number' | 'boolean' | 'json' | 'http.response';
export type AutonomyLevel = 'assisted' | 'autonomous-testing' | 'autonomous-recovery' | 'continuous-qa';

export type InputBinding =
  | { kind: 'constant'; value: unknown }
  | { kind: 'variable' | 'environment' | 'secret'; key: string }
  | { kind: 'output'; nodeId: string; port: string };

export interface WorkflowNode {
  id: string;
  type: string;
  version: number;
  name?: string;
  position: { x: number; y: number };
  required: boolean;
  config: Record<string, any>;
  inputs: Record<string, InputBinding>;
}

export interface WorkflowEdge {
  id: string;
  source: string;
  target: string;
  branch: string;
}

export interface WorkflowGraph {
  schemaVersion: number;
  autonomy: AutonomyLevel;
  limits: { maxDurationMs: number; maxNodeExecutions: number; maxConcurrency: number };
  variables: Record<string, { type: ValueType; value: unknown }>;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

export interface NodeInputPort {
  type: ValueType;
  required: boolean;
  secret?: boolean;
}

export interface NodeDefinition {
  type: string;
  version: number;
  title: string;
  category: string;
  effect: 'pure' | 'read' | 'write' | 'idempotent';
  branches: string[];
  inputs: Record<string, NodeInputPort>;
  outputs: Record<string, ValueType>;
  permissions: string[];
  timeoutMs: number;
  configSchema: { properties: Record<string, any> };
  automaticRecovery?: boolean;
}

export interface NodeAuthorization {
  projectOwned: boolean;
  permissions: string[];
  environmentAllowed: boolean;
  approvalRequired: boolean;
  approvalGranted: boolean;
  withinLimits: boolean;
}

export interface GraphValidationError {
  code: string;
  message: string;
  nodeId?: string;
}

export interface GraphValidationResult {
  valid: boolean;
  errors: GraphValidationError[];
}

export interface TestEvidenceCounts {
  total: number;
  passed: number;
  failed: number;
  errors: number;
  skipped: number;
}

export interface TestEvidence {
  status: string;
  counts: TestEvidenceCounts;
  requiredCaseIds?: string[];
  passedCaseIds?: string[];
  skippedIds?: string[];
  expectedSkippedIds?: string[];
  assertions?: { id: string; status: string }[];
  verifications?: { id: string; status: string }[];
}

export interface TestEvidenceGate {
  passed: boolean;
  reasons: string[];
  [key: string]: any;
}

export interface WorkflowNodeEvidence {
  id: string;
  required?: boolean;
  status: string;
  activation?: string;
  testsRequired?: boolean;
  evidence?: TestEvidence;
  outcome?: string;
}

export declare const AUTONOMY_LEVELS: AutonomyLevel[];
export declare const NODE_DEFINITIONS: NodeDefinition[];

export declare function getNodeDefinition(type: string, version?: number): NodeDefinition | undefined;
export declare function canConnectTypes(outputType: ValueType, inputType: ValueType): boolean;
export declare function canRetryNode(definition: NodeDefinition, state: { status: string; externalIdempotencyConfirmed?: boolean }): boolean;
export declare function allowsAutomaticRecovery(level: AutonomyLevel): boolean;

export declare function validateValue(type: ValueType, value: unknown): boolean;
export declare function validateJsonSchema(schema: unknown, value: unknown): boolean;
export declare function validateGraph(graph: WorkflowGraph): GraphValidationResult;

export declare function nextGraphStep(
  graph: WorkflowGraph,
  records: { id: string; nodeKey: string; nodeAttempt: number; status: string; state: any }[]
): { kind: 'execute' | 'skip' | 'complete' | 'invalid' | 'stalled'; node?: WorkflowNode; record?: any; errors?: GraphValidationError[] | { message: string }[] };

export declare function resolveNodeInputs(
  node: WorkflowNode,
  graph: WorkflowGraph,
  context: { outputs?: Record<string, any>; environment?: Record<string, any>; secrets?: Record<string, string> }
): Record<string, unknown>;

export declare function checkNodeAuthorization(
  definition: NodeDefinition,
  autonomyLevel: AutonomyLevel,
  authorization: NodeAuthorization
): { allowed: boolean; errors: string[] };

export declare function assessTestEvidence(evidence: TestEvidence): TestEvidenceGate;
export declare function assessWorkflowEvidence(items: WorkflowNodeEvidence[]): TestEvidenceGate;
export declare function redactWorkflowValue<T = unknown>(value: T, extraSecrets?: string[]): T;
