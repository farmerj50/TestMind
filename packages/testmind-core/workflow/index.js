// Reconstructed @testmind/core/workflow module.
// Built against tests/workflows/contracts.test.mjs and tests/workflows/engine.test.mjs
// as the authoritative specification, cross-checked against every real consumer in
// apps/api/src/runner/workflow-*.ts and apps/web/src/components/workflows/*.

// ── Node registry ───────────────────────────────────────────────────────────

export const AUTONOMY_LEVELS = ['assisted', 'autonomous-testing', 'autonomous-recovery', 'continuous-qa'];

export function allowsAutomaticRecovery(level) {
  return level === 'autonomous-recovery';
}

const PERMISSIONS = {
  workflow: ['workflow:execute'],
  api: ['api:execute', 'network:access'],
  apiWrite: ['api:execute', 'network:access', 'tests:write'],
  ui: ['ui:execute', 'network:access'],
  uiWrite: ['ui:execute', 'network:access', 'tests:write'],
  qa: ['ui:execute', 'network:access', 'tests:write', 'workflow:execute'],
  read: ['project:read', 'results:read'],
};

function def(type, {
  title, category, effect, branches, inputs = {}, outputs = {}, permissions,
  timeoutMs = 30000, configSchema = { properties: {} }, version = 1,
}) {
  return { type, version, title, category, effect, branches, inputs, outputs, permissions, timeoutMs, configSchema };
}

export const NODE_DEFINITIONS = [
  def('start', { title: 'Start', category: 'Control', effect: 'pure', branches: ['success', 'failure'], outputs: { variables: 'json' }, permissions: PERMISSIONS.workflow, timeoutMs: 5000 }),
  def('end', { title: 'End', category: 'Control', effect: 'pure', branches: [], permissions: PERMISSIONS.workflow, timeoutMs: 5000 }),
  def('condition', {
    title: 'Condition', category: 'Control', effect: 'pure', branches: ['true', 'false', 'failure'],
    inputs: { left: { type: 'json', required: true }, right: { type: 'json', required: false } },
    outputs: { matched: 'boolean' }, permissions: PERMISSIONS.workflow, timeoutMs: 5000,
    configSchema: { properties: { operator: { type: 'string', enum: ['exists', 'equals', 'not-equals', 'less-than', 'greater-than', 'contains'] } } },
  }),
  def('merge', {
    title: 'Merge', category: 'Control', effect: 'pure', branches: ['success', 'failure'], permissions: PERMISSIONS.workflow, timeoutMs: 5000,
    configSchema: { properties: { mode: { type: 'string', enum: ['all-active'] } } },
  }),
  def('assert', {
    title: 'Assert', category: 'Control', effect: 'pure', branches: ['success', 'failure'],
    inputs: { actual: { type: 'json', required: true } }, outputs: { result: 'json' },
    permissions: PERMISSIONS.workflow, timeoutMs: 5000,
    configSchema: { properties: { checks: { type: 'array' } } },
  }),
  def('report', {
    title: 'Report', category: 'Reporting', effect: 'pure', branches: ['success', 'failure'],
    outputs: { result: 'json' }, permissions: PERMISSIONS.workflow, timeoutMs: 5000,
  }),
  def('api.request', {
    title: 'API Request', category: 'API', effect: 'write', branches: ['success', 'failure'],
    inputs: {
      url: { type: 'string', required: true },
      headers: { type: 'json', required: false },
      body: { type: 'json', required: false },
      bearerToken: { type: 'string', required: false, secret: true },
    },
    outputs: { response: 'http.response' }, permissions: PERMISSIONS.api, timeoutMs: 30000,
    configSchema: { properties: { method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] }, timeoutMs: { type: 'integer', minimum: 1000, maximum: 120000 } } },
  }),
  def('api.generate', {
    title: 'Generate API Tests', category: 'API', effect: 'write', branches: ['success', 'failure'],
    inputs: { specification: { type: 'json', required: true } }, outputs: { collectionId: 'string' },
    permissions: PERMISSIONS.api, timeoutMs: 60000,
    configSchema: { properties: { name: { type: 'string' } } },
  }),
  def('api.suite', {
    title: 'Run API Suite', category: 'API', effect: 'write', branches: ['success', 'failure'],
    inputs: { collectionId: { type: 'string', required: true } }, outputs: { result: 'json' },
    permissions: PERMISSIONS.apiWrite, timeoutMs: 600000,
  }),
  def('ui.discover', {
    title: 'Discover Site', category: 'UI', effect: 'read', branches: ['success', 'failure'],
    inputs: { baseUrl: { type: 'string', required: true } }, outputs: { discovery: 'json' },
    permissions: PERMISSIONS.ui, timeoutMs: 120000,
    configSchema: { properties: { maxPages: { type: 'integer', minimum: 1, maximum: 200 } } },
  }),
  def('ui.generate', {
    title: 'Generate UI Tests', category: 'UI', effect: 'write', branches: ['success', 'failure'],
    inputs: { discovery: { type: 'json', required: true }, riskPlan: { type: 'json', required: false } },
    outputs: { suite: 'json' }, permissions: PERMISSIONS.ui, timeoutMs: 120000,
    configSchema: { properties: { maxTests: { type: 'integer', minimum: 1, maximum: 500 } } },
  }),
  def('ui.suite', {
    title: 'Run UI Suite', category: 'UI', effect: 'write', branches: ['success', 'failure'],
    inputs: { suite: { type: 'json', required: true }, baseUrl: { type: 'string', required: false }, riskPlan: { type: 'json', required: false } },
    outputs: { result: 'json' }, permissions: PERMISSIONS.uiWrite, timeoutMs: 600000,
  }),
  def('qa.autonomous', {
    title: 'Autonomous QA', category: 'QA', effect: 'write', branches: ['success', 'failure'],
    inputs: { baseUrl: { type: 'string', required: false } }, outputs: { result: 'json' },
    permissions: PERMISSIONS.qa, timeoutMs: 600000,
    configSchema: { properties: { maxPages: { type: 'integer', minimum: 1, maximum: 200 } } },
  }),
  def('legacy.action', {
    title: 'Legacy Action', category: 'QA', effect: 'write', branches: ['success', 'failure'],
    inputs: { baseUrl: { type: 'string', required: false } }, outputs: { result: 'json' },
    permissions: PERMISSIONS.qa, timeoutMs: 600000,
    configSchema: { properties: { maxPages: { type: 'integer', minimum: 1, maximum: 200 }, workflowType: { type: 'string', enum: ['qa-execute', 'repair'] } } },
  }),
  def('risk.select', {
    title: 'Select Risk', category: 'QA', effect: 'read', branches: ['success', 'failure'],
    outputs: { plan: 'json' }, permissions: PERMISSIONS.read, timeoutMs: 30000,
    configSchema: { properties: { maxWorkflows: { type: 'integer', minimum: 1, maximum: 50 }, maxTests: { type: 'integer', minimum: 1, maximum: 200 } } },
  }),
  def('evidence.analyze', {
    title: 'Analyze Evidence', category: 'Reporting', effect: 'read', branches: ['success', 'failure'],
    inputs: { result: { type: 'json', required: true } }, outputs: { analysis: 'json' },
    permissions: PERMISSIONS.read, timeoutMs: 30000,
  }),
  def('eval.run', {
    title: 'Run Evaluation', category: 'Evaluation', effect: 'write', branches: ['success', 'failure'],
    inputs: {
      datasetId: { type: 'string', required: true },
      datasetVersion: { type: 'string', required: true },
      applicationId: { type: 'string', required: true },
      applicationVersion: { type: 'string', required: true },
      gates: { type: 'json', required: false },
      cases: { type: 'json', required: false },
      datasetVersionId: { type: 'string', required: false },
    },
    outputs: { result: 'json' }, permissions: PERMISSIONS.apiWrite, timeoutMs: 60000,
  }),
  { ...def('python.script', {
    title: 'Python Script', category: 'Python', effect: 'idempotent', branches: ['success', 'failure'],
    inputs: { values: { type: 'json', required: false } }, outputs: { data: 'json', result: 'json' },
    permissions: PERMISSIONS.workflow, timeoutMs: 60000,
    configSchema: { properties: { script: { type: 'string' }, declarations: { type: 'object' }, timeoutMs: { type: 'integer', minimum: 1000, maximum: 30000 } } },
  }), automaticRecovery: false },
];

const BY_TYPE = new Map(NODE_DEFINITIONS.map(d => [d.type, d]));

export function getNodeDefinition(type, version) {
  const definition = BY_TYPE.get(type);
  if (!definition) return undefined;
  if (version !== undefined && version !== definition.version) return undefined;
  return definition;
}

export function canConnectTypes(outputType, inputType) {
  return outputType === inputType || inputType === 'json';
}

export function canRetryNode(definition, { status, externalIdempotencyConfirmed } = {}) {
  if (status !== 'failed') return false;
  if (['pure', 'read', 'idempotent'].includes(definition?.effect)) return true;
  return !!externalIdempotencyConfirmed;
}

// ── Value validation ────────────────────────────────────────────────────────

export function validateValue(type, value) {
  if (value === undefined) return false;
  switch (type) {
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'boolean': return typeof value === 'boolean';
    case 'http.response':
      return !!value && typeof value === 'object'
        && typeof value.status === 'number' && Number.isFinite(value.status)
        && !!value.headers && typeof value.headers === 'object'
        && value.body !== undefined
        && typeof value.durationMs === 'number' && Number.isFinite(value.durationMs);
    case 'json':
    default:
      return true;
  }
}

const SCHEMA_TYPES = ['string', 'number', 'integer', 'boolean', 'object', 'array', 'null'];

function schemaTypeOk(type, value) {
  switch (type) {
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'object': return !!value && typeof value === 'object' && !Array.isArray(value);
    case 'array': return Array.isArray(value);
    case 'null': return value === null;
    default: return true;
  }
}

const KNOWN_SCHEMA_KEYWORDS = new Set(['type', 'enum', 'properties', 'required', 'items', 'minimum', 'maximum', 'minLength', 'maxLength', 'additionalProperties']);

export function validateJsonSchema(schema, value) {
  if (!schema || typeof schema !== 'object') return true;
  for (const key of Object.keys(schema)) if (!KNOWN_SCHEMA_KEYWORDS.has(key)) throw new Error(`unknown keyword "${key}" in JSON schema`);
  if (schema.type && SCHEMA_TYPES.includes(schema.type) && !schemaTypeOk(schema.type, value)) return false;
  if (schema.enum && !schema.enum.some(item => item === value)) return false;
  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) return false;
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) return false;
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) return false;
    if (typeof schema.maximum === 'number' && value > schema.maximum) return false;
  }
  if (Array.isArray(value) && schema.items) {
    if (!value.every(item => validateJsonSchema(schema.items, item))) return false;
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    if (Array.isArray(schema.required) && !schema.required.every(key => Object.hasOwn(value, key))) return false;
    if (schema.properties) {
      for (const [key, sub] of Object.entries(schema.properties)) {
        if (Object.hasOwn(value, key) && !validateJsonSchema(sub, value[key])) return false;
      }
      if (schema.additionalProperties === false && !Object.keys(value).every(key => Object.hasOwn(schema.properties, key))) return false;
    }
  }
  return true;
}

// ── Graph validation ────────────────────────────────────────────────────────

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const TOP_LEVEL_KEYS = new Set(['schemaVersion', 'autonomy', 'limits', 'variables', 'nodes', 'edges']);
const MAX_DURATION_MS = 24 * 60 * 60 * 1000;

function err(code, message, nodeId) {
  return { code, message, nodeId };
}

export function validateGraph(graph) {
  const errors = [];
  if (!graph || typeof graph !== 'object') return { valid: false, errors: [err('schema', 'Graph is missing')] };

  for (const key of Object.keys(graph)) if (!TOP_LEVEL_KEYS.has(key)) errors.push(err('schema', `Unknown graph field ${key}`));
  if (graph.schemaVersion !== 1) errors.push(err('schema', 'Unsupported schema version'));
  if (!graph.limits || typeof graph.limits.maxDurationMs !== 'number' || graph.limits.maxDurationMs <= 0 || graph.limits.maxDurationMs > MAX_DURATION_MS) errors.push(err('schema', 'Workflow duration limit is missing or unbounded'));

  const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph.edges) ? graph.edges : [];

  if (graph.limits && typeof graph.limits.maxNodeExecutions === 'number' && graph.limits.maxNodeExecutions < nodes.length) errors.push(err('limit', 'Node execution limit is smaller than the graph'));

  const seenIds = new Set();
  const nodeById = new Map();
  for (const node of nodes) {
    if (seenIds.has(node.id)) errors.push(err('node-id', `Duplicate node id ${node.id}`, node.id));
    seenIds.add(node.id);
    nodeById.set(node.id, node);
    if (!getNodeDefinition(node.type, node.version)) errors.push(err('node-type', `Unsupported node type/version for ${node.id}`, node.id));
  }

  const startNodes = nodes.filter(n => n.type === 'start');
  if (startNodes.length !== 1) errors.push(err('start', 'Graph must have exactly one start node'));

  // Variables schema (checked independently of whether any node references them).
  const variables = graph.variables && typeof graph.variables === 'object' ? graph.variables : {};
  for (const [name, variable] of Object.entries(variables)) {
    if (!variable || typeof variable !== 'object' || !validateValue(variable.type, variable.value)) errors.push(err('variable', `Variable ${name} does not match its declared type`));
  }

  // Per-node config + input-binding validation.
  for (const node of nodes) {
    const definition = getNodeDefinition(node.type, node.version);
    if (!definition) continue;

    const config = node.config && typeof node.config === 'object' ? node.config : {};
    const knownConfigKeys = new Set(Object.keys(definition.configSchema?.properties ?? {}));
    for (const key of Object.keys(config)) if (!knownConfigKeys.has(key)) errors.push(err('config', `Unknown config field ${key}`, node.id));
    for (const [key, sub] of Object.entries(definition.configSchema?.properties ?? {})) {
      if (Object.hasOwn(config, key) && sub?.type && !schemaTypeOk(sub.type, config[key])) errors.push(err('config', `Config field ${key} has the wrong type`, node.id));
      else if (Object.hasOwn(config, key) && typeof config[key] === 'number') {
        if (typeof sub?.minimum === 'number' && config[key] < sub.minimum) errors.push(err('config', `Config field ${key} is below its minimum`, node.id));
        if (typeof sub?.maximum === 'number' && config[key] > sub.maximum) errors.push(err('config', `Config field ${key} is above its maximum`, node.id));
      }
    }

    if (node.type === 'python.script' && config.declarations && typeof config.declarations === 'object') {
      for (const [name, decl] of Object.entries(config.declarations)) {
        if (!decl || typeof decl !== 'object') { errors.push(err('config', `Python declaration ${name} is invalid`, node.id)); continue; }
        if (decl.secret !== undefined && decl.secret !== false) errors.push(err('config', `Python declaration ${name} cannot be a secret`, node.id));
        if (decl.path !== undefined && (typeof decl.path !== 'string' || !/^inputs\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.(?:txt|json)$/.test(decl.path))) errors.push(err('config', `Python declaration ${name} has an invalid path`, node.id));
      }
    }

    if (node.type === 'assert') {
      const checks = node.config?.checks;
      if (!Array.isArray(checks) || checks.length === 0) errors.push(err('config', 'Assert node requires at least one check', node.id));
      else for (const check of checks) {
        if (check.operator === 'schema') {
          if (!check.schema || typeof check.schema !== 'object' || (check.schema.type && !SCHEMA_TYPES.includes(check.schema.type))) errors.push(err('assertion', `Assert check ${check.id} has an invalid schema`, node.id));
        } else if (['equals', 'not-equals'].includes(check.operator) && !Object.hasOwn(check, 'expected')) {
          errors.push(err('assertion', `Assert check ${check.id} is missing its expectation`, node.id));
        }
      }
    }

    const inputs = node.inputs && typeof node.inputs === 'object' ? node.inputs : {};
    for (const [key, port] of Object.entries(definition.inputs)) {
      if (port.required && !Object.hasOwn(inputs, key)) errors.push(err('input-required', `Missing required input ${key}`, node.id));
    }
    for (const [key, binding] of Object.entries(inputs)) {
      const port = Object.hasOwn(definition.inputs, key) ? definition.inputs[key] : undefined;
      if (!port) { errors.push(err('input', `Unknown input ${key}`, node.id)); continue; }
      if (!binding || typeof binding !== 'object') { errors.push(err('input', `Invalid binding for ${key}`, node.id)); continue; }
      switch (binding.kind) {
        case 'constant':
          if (!validateValue(port.type, binding.value)) errors.push(err('input-type', `Input ${key} has an incompatible value`, node.id));
          break;
        case 'variable':
          if (DANGEROUS_KEYS.has(binding.key)) errors.push(err('binding-key', `Input ${key} references an unsafe variable name`, node.id));
          else if (!Object.hasOwn(variables, binding.key)) errors.push(err('variable', `Input ${key} references an unknown variable`, node.id));
          break;
        case 'environment':
          if (DANGEROUS_KEYS.has(binding.key)) errors.push(err('binding-key', `Input ${key} references an unsafe environment name`, node.id));
          break;
        case 'secret':
          if (DANGEROUS_KEYS.has(binding.key)) errors.push(err('binding-key', `Input ${key} references an unsafe secret name`, node.id));
          else if (!port.secret) errors.push(err('secret-binding', `Input ${key} does not accept a secret binding`, node.id));
          break;
        case 'output': {
          if (binding.nodeId === node.id) { errors.push(err('output-order', `Input ${key} cannot reference its own output`, node.id)); break; }
          const source = nodeById.get(binding.nodeId);
          const sourceDefinition = source && getNodeDefinition(source.type, source.version);
          const outputType = sourceDefinition && Object.hasOwn(sourceDefinition.outputs, binding.port) ? sourceDefinition.outputs[binding.port] : undefined;
          if (!sourceDefinition || outputType === undefined) { errors.push(err('output-type', `Input ${key} references an unknown output`, node.id)); break; }
          if (!canConnectTypes(outputType, port.type)) { errors.push(err('output-type', `Input ${key} is incompatible with the referenced output`, node.id)); break; }
          if (!dominates(binding.nodeId, node.id, nodes, edges)) errors.push(err('output-order', `Input ${key} references an output that is not guaranteed to have run first`, node.id));
          break;
        }
        default:
          errors.push(err('input', `Unknown binding kind for ${key}`, node.id));
      }
    }
  }

  // Edge validation.
  const edgeKeys = new Set();
  for (const edge of edges) {
    const source = nodeById.get(edge.source), target = nodeById.get(edge.target);
    if (!source || !target) { errors.push(err('edge-reference', `Edge references an unknown node (${edge.source} -> ${edge.target})`)); continue; }
    const definition = getNodeDefinition(source.type, source.version);
    if (definition && !definition.branches.includes(edge.branch)) errors.push(err('edge-branch', `Edge branch ${edge.branch} is not valid for ${source.id}`, source.id));
    const key = `${edge.source}->${edge.target}:${edge.branch}`;
    if (edgeKeys.has(key)) errors.push(err('edge-duplicate', `Duplicate connection ${key}`));
    edgeKeys.add(key);
  }

  if (hasCycle(nodes, edges)) errors.push(err('cycle', 'Graph contains a cycle'));

  if (startNodes.length === 1) {
    const reachable = reachableFrom(startNodes[0].id, edges);
    for (const node of nodes) {
      if (node.id === startNodes[0].id) continue;
      if (!reachable.has(node.id)) errors.push(err('unreachable', `Node ${node.id} is unreachable from start`, node.id));
    }
    for (const node of nodes) {
      if (node.type === 'end' || !reachable.has(node.id)) continue;
      if (!edges.some(e => e.source === node.id)) errors.push(err('dead-end', `Node ${node.id} has no outgoing edge`, node.id));
    }
  }

  return { valid: errors.length === 0, errors };
}

function reachableFrom(startId, edges) {
  const visited = new Set([startId]);
  const queue = [startId];
  while (queue.length) {
    const current = queue.shift();
    for (const edge of edges) if (edge.source === current && !visited.has(edge.target)) { visited.add(edge.target); queue.push(edge.target); }
  }
  return visited;
}

function hasCycle(nodes, edges) {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const state = new Map(nodes.map(n => [n.id, WHITE]));
  const adjacency = new Map(nodes.map(n => [n.id, []]));
  for (const edge of edges) adjacency.get(edge.source)?.push(edge.target);
  function visit(id) {
    state.set(id, GRAY);
    for (const next of adjacency.get(id) ?? []) {
      const s = state.get(next);
      if (s === GRAY) return true;
      if (s === WHITE && visit(next)) return true;
    }
    state.set(id, BLACK);
    return false;
  }
  for (const node of nodes) if (state.get(node.id) === WHITE && visit(node.id)) return true;
  return false;
}

// Strict dominance: does `ancestorId` appear on every path from the graph's start to `nodeId`?
function dominates(ancestorId, nodeId, nodes, edges) {
  if (ancestorId === nodeId) return false;
  const startNode = nodes.find(n => n.type === 'start');
  if (!startNode) return false;
  const predecessors = new Map(nodes.map(n => [n.id, []]));
  for (const edge of edges) predecessors.get(edge.target)?.push(edge.source);
  const order = nodes.map(n => n.id);
  const dom = new Map(order.map(id => [id, new Set(order)]));
  dom.set(startNode.id, new Set([startNode.id]));
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of order) {
      if (id === startNode.id) continue;
      const preds = predecessors.get(id) ?? [];
      if (!preds.length) continue;
      let intersection = null;
      for (const p of preds) {
        const pdom = dom.get(p) ?? new Set();
        if (intersection === null) intersection = new Set(pdom);
        else for (const item of [...intersection]) if (!pdom.has(item)) intersection.delete(item);
      }
      intersection = intersection ?? new Set();
      intersection.add(id);
      const current = dom.get(id);
      if (intersection.size !== current.size || [...intersection].some(item => !current.has(item))) { dom.set(id, intersection); changed = true; }
    }
  }
  return dom.get(nodeId)?.has(ancestorId) ?? false;
}

// ── Graph execution helpers ──────────────────────────────────────────────────

const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'skipped']);

export function nextGraphStep(graph, records) {
  const validation = validateGraph(graph);
  if (!validation.valid) return { kind: 'invalid', errors: validation.errors };

  const byNode = new Map();
  for (const record of records) {
    const previous = byNode.get(record.nodeKey);
    if (!previous || previous.nodeAttempt < record.nodeAttempt) byNode.set(record.nodeKey, record);
  }
  for (const node of graph.nodes) {
    const record = byNode.get(node.id);
    if (record && ['running', 'pending'].includes(record.status)) return { kind: 'execute', node, record };
  }

  const isResolved = id => TERMINAL_STATUSES.has(byNode.get(id)?.status);

  for (const node of graph.nodes) {
    if (isResolved(node.id)) continue;
    if (node.type === 'start') return { kind: 'execute', node };
    const incoming = graph.edges.filter(e => e.target === node.id);
    if (!incoming.length) continue;
    if (!incoming.every(e => isResolved(e.source))) continue;
    const active = incoming.some(e => {
      const source = byNode.get(e.source);
      return source && source.status !== 'skipped' && source.state?.branch === e.branch;
    });
    return active ? { kind: 'execute', node } : { kind: 'skip', node };
  }

  if (graph.nodes.every(n => isResolved(n.id))) return { kind: 'complete' };
  return { kind: 'stalled', errors: [{ message: 'Workflow cannot make progress' }] };
}

export function resolveNodeInputs(node, graph, context) {
  const definition = getNodeDefinition(node.type, node.version);
  const resolved = {};
  const inputs = node.inputs ?? {};
  for (const [key, port] of Object.entries(definition?.inputs ?? {})) {
    const binding = inputs[key];
    if (!binding) {
      if (port.required) throw new Error(`Missing required input ${key}`);
      continue;
    }
    let value;
    switch (binding.kind) {
      case 'constant': value = binding.value; break;
      case 'variable': value = graph.variables?.[binding.key]?.value; break;
      case 'environment': value = context?.environment?.[binding.key]; break;
      case 'secret': value = context?.secrets?.[binding.key]; break;
      case 'output': value = context?.outputs?.[binding.nodeId]?.[binding.port]; break;
      default: throw new Error(`Unknown input binding kind for ${key}`);
    }
    if (value === undefined) {
      if (port.required) throw new Error(`Input ${key} resolved to no value`);
      continue;
    }
    if (!validateValue(port.type, value)) throw new Error(`Input ${key} does not match the expected type`);
    resolved[key] = value;
  }
  return resolved;
}

// ── Authorization ────────────────────────────────────────────────────────────

export function checkNodeAuthorization(definition, autonomyLevel, authorization = {}) {
  const errors = [];
  if (!authorization.projectOwned) errors.push('The requesting user does not own this project');
  if (!authorization.environmentAllowed) errors.push('The target environment is not permitted for this run');
  if (authorization.approvalRequired && !authorization.approvalGranted) errors.push('This node requires approval before it can run');
  if (!authorization.withinLimits) errors.push('The workflow has exceeded its execution limits');
  const granted = new Set(authorization.permissions ?? []);
  const missing = (definition?.permissions ?? []).filter(p => !granted.has(p));
  if (missing.length) errors.push(`Missing permissions: ${missing.join(', ')}`);
  return { allowed: errors.length === 0, errors };
}

// ── Evidence / quality gates ─────────────────────────────────────────────────

export function assessTestEvidence(evidence) {
  const reasons = [];
  if (evidence?.status !== 'succeeded') reasons.push('Test run did not succeed');
  const counts = evidence?.counts;
  if (!counts || typeof counts !== 'object') {
    reasons.push('No test counts were reported');
  } else {
    const sum = (counts.passed ?? 0) + (counts.failed ?? 0) + (counts.errors ?? 0) + (counts.skipped ?? 0);
    if (!counts.total) reasons.push('No tests were executed');
    else if (counts.total !== sum) reasons.push('Test counts are inconsistent');
    else if (!counts.passed) reasons.push('No tests passed');
    if ((counts.failed ?? 0) > 0) reasons.push('One or more tests failed');
    if ((counts.errors ?? 0) > 0) reasons.push('One or more tests errored');
    if ((counts.skipped ?? 0) > 0) {
      const skippedIds = evidence.skippedIds;
      const expected = evidence.expectedSkippedIds;
      if (!Array.isArray(skippedIds) || skippedIds.length !== counts.skipped) reasons.push('Skipped tests are not accounted for');
      else if (!Array.isArray(expected) || !skippedIds.every(id => expected.includes(id))) reasons.push('Skipped tests were not explicitly expected');
    }
  }
  if (Array.isArray(evidence?.requiredCaseIds)) {
    const passedIds = evidence.passedCaseIds ?? [];
    if (!evidence.requiredCaseIds.every(id => passedIds.includes(id))) reasons.push('A required test case did not pass');
  }
  if (Array.isArray(evidence?.assertions) && !evidence.assertions.every(a => a.status === 'passed')) reasons.push('An assertion did not pass');
  if (Array.isArray(evidence?.verifications) && !evidence.verifications.every(v => v.status === 'passed')) reasons.push('A verification phase did not pass');
  return { passed: reasons.length === 0, reasons };
}

export function assessWorkflowEvidence(items) {
  const reasons = [];
  if (!items.length) reasons.push('Workflow produced no nodes to evaluate');
  let hasValidEvidence = false;
  for (const item of items) {
    if (item.status === 'skipped' && item.activation === 'not-selected') continue;
    if (item.status === 'failed') { reasons.push(`Node ${item.id} failed`); continue; }
    if (item.status !== 'succeeded') { reasons.push(`Node ${item.id} did not complete`); continue; }
    if (item.testsRequired) {
      if (item.evidence && assessTestEvidence(item.evidence).passed) hasValidEvidence = true;
      else reasons.push(`Node ${item.id} produced no valid testing evidence`);
    }
  }
  if (items.length && !hasValidEvidence) reasons.push('Workflow produced no valid testing evidence');
  return { passed: reasons.length === 0, reasons };
}

// ── Redaction ────────────────────────────────────────────────────────────────

function sensitiveKey(key) {
  const normalized = String(key).toLowerCase().replace(/[^a-z]/g, '');
  return ['authorization', 'cookie', 'setcookie'].includes(normalized)
    || normalized.includes('secret') || normalized.includes('token')
    || normalized.includes('password') || normalized.includes('apikey');
}

function expandSecrets(extraSecrets) {
  const set = new Set();
  for (const raw of extraSecrets ?? []) {
    if (typeof raw !== 'string' || !raw) continue;
    set.add(raw);
    const match = raw.match(/^(?:bearer|basic|token)\s+(.+)$/i);
    if (match?.[1]) set.add(match[1]);
  }
  return [...set].sort((a, b) => b.length - a.length);
}

const CREDENTIAL_SHAPE_PATTERNS = [
  /\b(?:Bearer|Basic)\s+\S+/gi,
  /\b(?:token|key|secret|password|apikey|api[_-]key)\s*[=:]\s*\S+/gi,
];

function redactString(value, secrets) {
  let result = value;
  for (const pattern of CREDENTIAL_SHAPE_PATTERNS) result = result.replace(pattern, '[redacted]');
  for (const secret of secrets) {
    if (!secret) continue;
    if (result === secret) { result = '[redacted]'; continue; }
    if (result.includes(secret)) result = result.split(secret).join('[redacted]');
  }
  return result;
}

export function redactWorkflowValue(value, extraSecrets = []) {
  const secrets = expandSecrets(extraSecrets);
  function visit(node, keyHint) {
    if (node instanceof Date) return node.toISOString();
    if (typeof node === 'string') {
      if (keyHint !== undefined && sensitiveKey(keyHint)) return '[redacted]';
      return redactString(node, secrets);
    }
    if (Array.isArray(node)) return node.map(item => visit(item));
    if (node && typeof node === 'object') {
      const out = {};
      for (const [key, val] of Object.entries(node)) out[key] = visit(val, key);
      return out;
    }
    return node;
  }
  return visit(value);
}
