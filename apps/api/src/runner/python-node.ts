import type { NodeAuthorization } from '@testmind/core/workflow';
import { authorizedWorkflowContext, watchWorkflowExecution } from '../lib/workflow-execution-policy.js';
import { verifyPytestSandbox } from './pytest-sandbox.js';
import { executePythonScript } from './python-script.js';

function configuredImage() {
  if (process.env.TM_PYTHON_WORKFLOWS_ENABLED !== '1') throw new Error('PYTHON_WORKFLOWS_DISABLED');
  const image = process.env.TM_PYTHON_SANDBOX_IMAGE ?? '';
  if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error('PYTEST_SANDBOX_UNVERIFIED');
  return image;
}

/** Only the existing graph worker calls this handler; settings are server-owned. */
export async function executePythonWorkflowNode(context: any) {
  const imageId = configuredImage();
  const projectId = context.run.workflow.projectId;
  const initial = await authorizedWorkflowContext(context.run.id, projectId);
  const graph = initial.snapshot.configJson.graph;
  const node = graph.nodes.find((item: any) => item.id === context.node.id && item.type === 'python.script');
  if (!node || initial.run.versionId !== context.run.versionId || initial.run.operatorJobId !== context.run.operatorJobId
    || !Array.isArray(context.secretValues) || context.secretValues.some((value: unknown) => typeof value !== 'string')) {
    throw new Error('PYTHON_EXECUTION_UNAUTHORIZED');
  }
  const authorize = async (): Promise<NodeAuthorization> => {
    if (configuredImage() !== imageId) throw new Error('PYTEST_SANDBOX_UNVERIFIED');
    const current = await authorizedWorkflowContext(context.run.id, projectId);
    if (current.run.versionId !== initial.run.versionId || current.run.operatorJobId !== initial.run.operatorJobId) throw new Error('PYTHON_EXECUTION_UNAUTHORIZED');
    // The existing server policy has just verified owner, approval, environment,
    // current status and global duration. These flags never come from graph input.
    return { projectOwned: true, permissions: ['workflow:execute'], environmentAllowed: true,
      approvalRequired: true, approvalGranted: true, withinLimits: Date.now() < context.task.state.deadline };
  };
  const watch = watchWorkflowExecution(context.run.id, projectId);
  try {
    const signal = AbortSignal.any([context.signal, watch.signal]);
    signal.throwIfAborted();
    const sandbox = await verifyPytestSandbox(imageId);
    signal.throwIfAborted();
    return await executePythonScript({ sandbox, autonomy: graph.autonomy, authorize, signal,
      deadline: context.task.state.deadline, secretValues: context.secretValues,
    }, { script: node.config.script, declarations: node.config.declarations, inputs: context.inputs.values, timeoutMs: node.config.timeoutMs });
  } finally { watch.stop(); }
}
