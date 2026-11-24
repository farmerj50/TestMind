import { assessWorkflowEvidence, checkNodeAuthorization, getNodeDefinition, nextGraphStep, resolveNodeInputs, validateValue, type WorkflowGraph, type NodeAuthorization } from '@testmind/core/workflow';
import { executeControl } from './workflow-controls.js';

export interface GraphState { phase?: string; inputs?: any; outputs?: any; checkpoint?: any; branch?: string; outcome?: string; failureKind?: string; evidence?: any; activation?: string; deadline?: number }
export interface GraphTask { id: string; nodeKey: string; nodeAttempt: number; status: string; state: GraphState }
export interface GraphRuntime {
  debugNodeId?: string;
  sourceOutputs?: Record<string, any>;
  now(): number;
  startedAt: number;
  canceled(): Promise<boolean>;
  records(): Promise<GraphTask[]>;
  executionCount?(): Promise<number>;
  create(node: any, state: GraphState, status: string): Promise<GraphTask>;
  save(task: GraphTask, status: string, state: GraphState, error?: string): Promise<void>;
  authorize(node: any): Promise<NodeAuthorization>;
  bindings(): Promise<{ environment: Record<string, any>; secrets: Record<string, string> }>;
  execute(node: any, inputs: any, task: GraphTask, checkpoint: (value: any) => Promise<void>, signal: AbortSignal): Promise<any>;
}
const testingTypes = new Set(['assert', 'api.suite', 'ui.suite', 'qa.autonomous', 'python.script', 'eval.run']);
export function taskEvidence(graph: WorkflowGraph, tasks: GraphTask[]) {
  const latest = new Map<string, GraphTask>();
  for (const task of tasks) if (!latest.has(task.nodeKey) || latest.get(task.nodeKey)!.nodeAttempt < task.nodeAttempt) latest.set(task.nodeKey, task);
  return [...latest.values()].map(task => {
    const node = graph.nodes.find(n => n.id === task.nodeKey)!;
    return { id: node.id, required: node.required, status: task.status, activation: task.state.activation as any,
      testsRequired: testingTypes.has(node.type), evidence: task.state.evidence, outcome: task.state.outcome as any };
  });
}

// Performs at most one bounded node step per invocation. Child-job checkpoints
// survive BullMQ retries and worker restarts. External writes are never replayed
// after an ambiguous inline execution.
export async function advanceWorkflow(graph: WorkflowGraph, runtime: GraphRuntime) {
  if (await runtime.canceled()) return { status: 'canceled' };
  if (runtime.now() - runtime.startedAt >= graph.limits.maxDurationMs) return { status: 'failed', error: 'Workflow duration limit exceeded' };
  const records = await runtime.records();
  let step = nextGraphStep(graph, records.map(r => ({ ...r, branch: r.state.branch })));
  if (runtime.debugNodeId && step.kind !== 'invalid') {
    const node = graph.nodes.find(n => n.id === runtime.debugNodeId);
    if (!node) return { status: 'failed', error: 'Debug node is missing' };
    const record = records.filter(r => r.nodeKey === node.id).sort((a, b) => b.nodeAttempt - a.nodeAttempt)[0];
    if (record && !['pending', 'running'].includes(record.status)) return { status: record.status === 'succeeded' ? 'debug-completed' : 'failed', error: record.status === 'succeeded' ? undefined : 'Node diagnostic failed' };
    step = { kind: 'execute', node, record };
  }
  if (step.kind === 'invalid' || step.kind === 'stalled') return { status: 'failed', error: step.errors?.map(e => e.message).join('; ') ?? 'Workflow cannot make progress' };
  if (step.kind === 'complete') {
    const gate = assessWorkflowEvidence(taskEvidence(graph, records));
    return { status: gate.passed ? 'succeeded' : 'failed', error: gate.passed ? undefined : gate.reasons.join('; '), gate };
  }
  const node = step.node!;
  if ((runtime.executionCount ? await runtime.executionCount() : records.length) >= graph.limits.maxNodeExecutions && !step.record) return { status: 'failed', error: 'Workflow node execution limit exceeded' };
  if (step.kind === 'skip') { await runtime.create(node, { activation: 'not-selected' }, 'skipped'); return { status: 'pending' }; }
  const definition = getNodeDefinition(node.type, node.version)!;
  let task = records.find(r => r.id === (step.record as any)?.id);
  let state = task?.state ?? { activation: 'selected', deadline: Math.min(runtime.startedAt + graph.limits.maxDurationMs, runtime.now() + definition.timeoutMs) };
  try {
    const policy = checkNodeAuthorization(definition, graph.autonomy, await runtime.authorize(node));
    if (!policy.allowed) throw new Error(policy.errors.join('; '));
    if (state.deadline! <= runtime.now()) throw new Error('Node execution deadline exceeded');
    if (state.phase === 'executing' && !state.checkpoint && !['pure', 'read'].includes(definition.effect)) {
      state.outcome = 'unknown'; throw new Error('Execution outcome is unknown after interruption; automatic replay is unsafe');
    }
    if (!state.inputs) {
      const outputs = { ...runtime.sourceOutputs, ...Object.fromEntries([...records].sort((a, b) => a.nodeAttempt - b.nodeAttempt).map(r => [r.nodeKey, r.state.outputs])) };
      state.inputs = resolveNodeInputs(node, graph, { outputs, ...await runtime.bindings() });
    }
    if (!task) task = await runtime.create(node, state, 'running');
    state = { ...state, phase: 'executing' }; await runtime.save(task, 'running', state);
    const checkpoint = async (value: any) => { state = { ...state, checkpoint: value }; await runtime.save(task!, 'running', state); };
    const controller = new AbortController();
    const monitor = setInterval(() => { void runtime.canceled().then(canceled => { if (canceled) controller.abort(new Error('Workflow canceled')); }).catch(error => controller.abort(error)); }, 250);
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(Math.max(1, state.deadline! - runtime.now()))]);
    let result;
    try { result = executeControl(node, state.inputs, { variables: Object.fromEntries(Object.entries(graph.variables).map(([key, value]) => [key, value.value])), evidence: taskEvidence(graph, records) }) ?? await runtime.execute(node, state.inputs, { ...task, state }, checkpoint, signal); }
    finally { clearInterval(monitor); }
    if (await runtime.canceled()) throw new Error('Workflow canceled');
    if (result.pending) return { status: 'pending' };
    if (runtime.now() > state.deadline!) throw new Error('Node execution deadline exceeded');
    if (JSON.stringify(result.outputs ?? {}).length > 5_000_000) throw new Error('Node output exceeds the persisted evidence size limit');
    for (const [port, type] of Object.entries(definition.outputs)) if (!validateValue(type, result.outputs?.[port])) throw new Error(`Handler returned invalid ${port} output`);
    if (node.type !== 'end' && !definition.branches.includes(result.branch ?? 'success')) throw new Error('Handler returned an invalid execution branch');
    state = { ...state, ...result, phase: 'finished', ...(result.outcome === 'failed' ? { failureKind: 'assertion' } : {}) };
    await runtime.save(task, ['failed', 'error', 'unknown'].includes(result.outcome) ? 'failed' : 'succeeded', state);
  } catch (error: any) {
    if (!task) task = await runtime.create(node, state, 'running');
    const canceled = await runtime.canceled();
    state = { ...state, phase: 'finished', branch: 'failure', outcome: state.outcome ?? 'error', failureKind: canceled ? 'canceled' : state.outcome === 'unknown' ? 'unknown' : /deadline|timeout|timed out/i.test(error?.message ?? '') || error?.name === 'TimeoutError' ? 'timeout' : 'infrastructure' };
    await runtime.save(task, 'failed', state, error?.message ?? 'Node execution failed');
    if (canceled) return { status: 'canceled' };
  }
  return { status: 'pending' };
}
