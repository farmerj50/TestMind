import { assessWorkflowEvidence, validateJsonSchema, type WorkflowNode } from '@testmind/core/workflow';

function atPath(value: any, path = '') {
  for (const part of path.replace(/^\$\.?/, '').split(/[.\[\]]+/).filter(Boolean)) {
    if (['__proto__', 'constructor', 'prototype'].includes(part) || value === null || typeof value !== 'object' || !Object.hasOwn(value, part)) return undefined;
    value = value[part];
  }
  return value;
}
function equal(a: any, b: any): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a); return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && equal(a[key], b[key]));
}
function compare(operator: string, actual: any, expected: any): boolean {
  switch (operator) {
    case 'exists': return actual !== undefined;
    case 'equals': return equal(actual, expected);
    case 'not-equals': return actual !== undefined && !equal(actual, expected);
    case 'less-than': return typeof actual === 'number' && typeof expected === 'number' && actual < expected;
    case 'greater-than': return typeof actual === 'number' && typeof expected === 'number' && actual > expected;
    case 'contains': return typeof actual === 'string' && typeof expected === 'string' ? actual.includes(expected) : Array.isArray(actual) && actual.some(item => equal(item, expected));
    default: throw new Error('Unsupported comparison');
  }
}
export function executeControl(node: WorkflowNode, inputs: any, context: { variables: any; evidence: any[] }) {
  switch (node.type) {
    case 'start': return { outputs: { variables: context.variables }, branch: 'success' };
    case 'end': case 'merge': return { outputs: {}, branch: 'success' };
    case 'condition': {
      const matched = compare(node.config.operator, inputs.left, inputs.right);
      return { outputs: { matched }, branch: matched ? 'true' : 'false' };
    }
    case 'assert': {
      const assertions = node.config.checks.map((check: any) => {
        const actual = atPath(inputs.actual, check.path);
        const passed = check.operator === 'schema' ? validateJsonSchema(check.schema, actual) : compare(check.operator, actual, check.expected);
        return { id: check.id, status: passed ? 'passed' : 'failed', actual: actual ?? null, expected: check.expected ?? null };
      });
      const passed = assertions.filter((a: any) => a.status === 'passed').length;
      const evidence = { status: 'succeeded', counts: { total: assertions.length, passed, failed: assertions.length - passed, errors: 0, skipped: 0 }, assertions };
      const outcome = passed === assertions.length ? 'passed' : 'failed';
      return { outputs: { result: { outcome, evidence } }, evidence, outcome, branch: outcome === 'passed' ? 'success' : 'failure' };
    }
    case 'report': {
      const gate = assessWorkflowEvidence(context.evidence);
      return { outputs: { result: { outcome: gate.passed ? 'passed' : 'failed', qualityGate: gate, nodes: context.evidence } }, outcome: gate.passed ? 'passed' : 'failed', branch: gate.passed ? 'success' : 'failure' };
    }
    default: return null;
  }
}
