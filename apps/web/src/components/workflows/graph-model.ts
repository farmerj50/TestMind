import { getNodeDefinition, type WorkflowGraph, type WorkflowNode } from '@testmind/core/workflow';
export const nodeId = () => `n-${crypto.randomUUID().slice(0, 12)}`;
export function newNode(type: string, position = { x: 300, y: 150 }): WorkflowNode {
  const definition = getNodeDefinition(type)!;
  if (type === 'python.script') return { id: nodeId(), type, version: definition.version, name: definition.title, position, required: true,
    config: { script: 'def main(inputs):\n    return inputs\n', declarations: {}, timeoutMs: 10000 },
    inputs: { values: { kind: 'constant', value: {} } } };
  const defaults: Record<string, unknown> = { 'condition': { operator: 'equals' }, 'merge': { mode: 'all-active' }, 'assert': { checks: [{ id: 'status', operator: 'equals', path: 'status', expected: 200 }] }, 'api.request': { method: 'GET', timeoutMs: 30000 }, 'api.generate': { name: 'API tests' }, 'ui.discover': { maxPages: 10 }, 'ui.generate': { maxTests: 25 }, 'qa.autonomous': { maxPages: 10 }, 'risk.select': { maxWorkflows: 5, maxTests: 25 }, 'legacy.action': { workflowType: 'qa-execute' } };
  return { id: nodeId(), type, version: definition.version, name: definition.title, position, required: true, config: (defaults[type] ?? {}) as Record<string, unknown>, inputs: Object.fromEntries(Object.entries(definition.inputs).filter(([, port]) => port.required).map(([key, port]) => [key, { kind: 'constant', value: port.type === 'string' ? '' : null }])) };
}
export function workflowTemplate(kind = 'api'): WorkflowGraph {
  const types = kind === 'ui' ? ['start', 'ui.discover', 'ui.generate', 'ui.suite', 'report', 'end'] : kind === 'autonomous' ? ['start', 'qa.autonomous', 'report', 'end'] : ['start', 'api.request', 'assert', 'report', 'end'];
  const nodes = types.map((type, index) => ({ ...newNode(type, { x: index * 270, y: 110 }), id: `step-${index}` }));
  if (kind === 'api') { nodes[1].inputs.url = { kind: 'environment', key: 'baseUrl' }; nodes[2].inputs.actual = { kind: 'output', nodeId: nodes[1].id, port: 'response' }; }
  else {
    nodes[1].inputs.baseUrl = { kind: 'environment', key: 'baseUrl' };
    if (kind === 'ui') { nodes[2].inputs.discovery = { kind: 'output', nodeId: nodes[1].id, port: 'discovery' }; nodes[3].inputs.suite = { kind: 'output', nodeId: nodes[2].id, port: 'suite' }; }
  }
  return { schemaVersion: 1, autonomy: 'assisted', limits: { maxDurationMs: 3600000, maxNodeExecutions: 100, maxConcurrency: 1 }, variables: {}, nodes, edges: nodes.slice(1).map((node, index) => ({ id: `edge-${index}`, source: nodes[index].id, target: node.id, branch: 'success' })) };
}
