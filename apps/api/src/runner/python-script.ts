import { assessTestEvidence, checkNodeAuthorization, type AutonomyLevel, type NodeAuthorization, type NodeDefinition } from '@testmind/core/workflow';
import { runIsolatedPytest, type VerifiedPytestSandbox } from './pytest-sandbox.js';
import { boundedPythonJson, preparePythonInputs, safePythonValue, type PythonInputDeclaration } from './python-inputs.js';

const CASE_ID = JSON.stringify(['test_testmind_script', 'test_script']);
// Adapter policy only: no node registration, automatic recovery, or second execution engine.
const policy = { permissions: ['workflow:execute'], automaticRecovery: false } as NodeDefinition;
const WRAPPER = `import json, runpy

def test_script(record_property):
    try:
        with open('/work/project/inputs.json', encoding='utf-8') as stream:
            inputs = json.load(stream)
        scope = runpy.run_path('/work/project/script.py', run_name='__testmind_script__')
        entrypoint = scope.get('main')
        if not callable(entrypoint):
            raise TypeError('Python script requires main(inputs)')
        result = entrypoint(inputs)
        serialized = json.dumps(result, allow_nan=False, ensure_ascii=True)
        if len(serialized.encode('utf-8')) > 65536:
            raise ValueError('Python output exceeds limit')
    except AssertionError:
        record_property('testmind.python.status', 'assertion')
        raise
    except BaseException:
        record_property('testmind.python.status', 'error')
        raise
    record_property('testmind.python.status', 'completed')
    record_property('testmind.python.result', serialized)
`;

export interface PythonScriptContext {
  sandbox: VerifiedPytestSandbox;
  autonomy: AutonomyLevel;
  /** Server-owned authorization callback, never graph configuration or client input. */
  authorize(): Promise<NodeAuthorization>;
  signal: AbortSignal;
  deadline: number;
  secretValues: string[];
}

export async function executePythonScript(context: PythonScriptContext, request: {
  script: string; declarations: Record<string, PythonInputDeclaration>; inputs: Record<string, unknown>; timeoutMs: number;
}) {
  const authorize = async () => {
    try {
      const authorization = await context.authorize();
      if (!checkNodeAuthorization(policy, context.autonomy, authorization).allowed) throw new Error();
    } catch { throw new Error('PYTHON_EXECUTION_UNAUTHORIZED'); }
  };
  await authorize();
  if (!context.signal || !Number.isFinite(context.deadline) || !Number.isSafeInteger(request.timeoutMs)
    || request.timeoutMs < 100 || request.timeoutMs > 30000) throw new Error('PYTHON_INPUT_UNSAFE');
  // Reject unsupported request fields (host paths, env, shell flags, bindings, etc.).
  if (Object.keys(request).some(key => !['script', 'declarations', 'inputs', 'timeoutMs'].includes(key))
    || typeof request.script !== 'string' || !request.script.trim()) throw new Error('PYTHON_INPUT_UNSAFE');
  const secretValues = [...context.secretValues];
  const script = JSON.parse(safePythonValue(request.script, secretValues, 131072));
  const scoped = preparePythonInputs(request.declarations, request.inputs, secretValues);
  const files = { ...scoped.files, 'script.py': script, 'inputs.json': boundedPythonJson(scoped.inputs, 131072), 'test_testmind_script.py': WRAPPER };
  await authorize();
  const timeoutMs = Math.min(request.timeoutMs, Math.floor(context.deadline - Date.now()));
  if (timeoutMs < 100) throw new Error('Python execution deadline exceeded');
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), Math.max(1, context.deadline - Date.now()));
  let result: Awaited<ReturnType<typeof runIsolatedPytest>>;
  try {
    result = await runIsolatedPytest(context.sandbox, { files, timeoutMs, signal: AbortSignal.any([context.signal, deadline.signal]) });
  } finally { clearTimeout(timer); }
  await authorize();
  const item = result.cases.length === 1 && result.cases[0].id === CASE_ID ? result.cases[0] : undefined;
  let data: unknown = null;
  let passed = result.quality.passed && item?.scriptResult?.status === 'completed';
  if (passed) {
    try { data = JSON.parse(safePythonValue(JSON.parse(item!.scriptResult!.json!), secretValues)); }
    catch { passed = false; }
  }
  const timedOut = deadline.signal.aborted || context.signal.reason?.name === 'TimeoutError' || result.outcome === 'timeout';
  const canceled = !timedOut && (result.outcome === 'canceled' || context.signal.aborted);
  if (canceled || timedOut) passed = false;
  // Never return raw XML, script source, input values, diagnostics, logs or property strings.
  const evidence = { status: passed ? 'succeeded' : canceled ? 'canceled' : 'failed', counts: { ...result.evidence.counts },
    passedCaseIds: passed ? [CASE_ID] : [], requiredCaseIds: [CASE_ID] };
  const qualityGate = assessTestEvidence(evidence);
  const outcome = passed ? 'passed' : item?.scriptResult?.status === 'assertion' && !canceled ? 'failed' : 'error';
  const failureKind = passed ? undefined : canceled ? 'canceled' : timedOut ? 'timeout'
    : outcome === 'failed' ? 'assertion' : 'infrastructure';
  return { outputs: { data: passed ? data : null, result: { source: 'python', outcome, evidence, qualityGate } },
    evidence, outcome, branch: passed ? 'success' : 'failure', ...(failureKind ? { failureKind } : {}) };
}
