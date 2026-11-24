import { useEffect, useState } from 'react';
import { useApi } from '../../lib/api';
import { getNodeDefinition, canRetryNode } from '@testmind/core/workflow';

export default function WorkflowRunInspector({ runId, onClose, onState }: { runId: string; onClose(): void; onState?(statuses: Record<string, string>): void }) {
  const { apiFetch, apiFetchRaw } = useApi();
  const [detail, setDetail] = useState<any>();
  const [selected, setSelected] = useState<string>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let mounted = true;
    const load = async () => { try { const data = await apiFetch<any>(`/workflows/runs/${runId}`); if (mounted) { setDetail(data); onState?.(Object.fromEntries(data.tasks.filter((task: any) => task.nodeKey).map((task: any) => [task.nodeKey, task.status]))); } } catch (error: any) { if (mounted) setError(error.message); } };
    void load(); const timer = window.setInterval(load, 3000);
    return () => { mounted = false; clearInterval(timer); };
  }, [apiFetch, runId, onState]);
  const task = detail?.tasks.find((item: any) => item.id === selected) ?? detail?.tasks[0];
  const graph = detail?.run.version?.snapshotJson?.configJson?.graph;
  const node = graph?.nodes.find((node: any) => node.id === task?.nodeKey);
  const definition = node && getNodeDefinition(node.type, node.version);
  async function action(action: string) {
    setBusy(true); setError('');
    try { await apiFetch(`/workflows/runs/${runId}/${action}`, { method: 'POST' }); setDetail(await apiFetch(`/workflows/runs/${runId}`)); }
    catch (error: any) { setError(error.message); } finally { setBusy(false); }
  }
  async function download(id: string) {
    try { const response = await apiFetchRaw(`/workflows/artifacts/${id}`); if (!response.ok) throw new Error('Artifact is unavailable'); const url = URL.createObjectURL(await response.blob()); const link = document.createElement('a'); link.href = url; link.download = `evidence-${id}`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
    catch (error: any) { setError(error.message); }
  }
  return <section className="rounded-xl border border-slate-200 bg-white p-5 space-y-4" aria-label="Workflow execution inspector"><div className="flex flex-wrap justify-between gap-3"><div><h2 className="font-semibold">Execution details · {detail?.run.status ?? 'Loading'}</h2><p className="text-xs text-slate-500">Run {runId} · Version {detail?.run.version?.digest?.slice(0, 12) ?? 'legacy'}</p>{detail?.run.contextJson?.debugNodeId && <p className="text-sm text-amber-700">Node diagnostic only. This does not verify the complete workflow.</p>}</div><button onClick={onClose}>Close details</button></div>
    {error && <p role="alert" className="text-sm text-rose-700">{error}</p>}{detail?.run.error && <p className="text-sm text-rose-700">{detail.run.error}</p>}
    <div className="flex gap-3 text-sm">{['queued', 'running', 'blocked', 'awaiting_approval'].includes(detail?.run.status) && <button disabled={busy} onClick={() => action('cancel')}>Cancel run</button>}{['queued', 'running'].includes(detail?.run.status) && graph && <button disabled={busy} onClick={() => action('resume')}>Resume saved execution</button>}<button onClick={() => { const blob = new Blob([JSON.stringify(detail, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `workflow-${runId}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }}>Export report</button></div>
    <div className="grid gap-4 lg:grid-cols-[300px_1fr]"><div className="max-h-[500px] overflow-auto space-y-2">{detail?.tasks.map((item: any) => <button className={`block w-full rounded border p-2 text-left text-sm ${task?.id === item.id ? 'border-blue-500 bg-blue-50' : 'border-slate-200'}`} key={item.id} onClick={() => setSelected(item.id)}><strong>{graph?.nodes.find((node: any) => node.id === item.nodeKey)?.name || item.nodeKey || item.id}</strong><span className="block text-xs">{item.status} · attempt {item.nodeAttempt} · {item.startedAt && item.finishedAt ? `${new Date(item.finishedAt).getTime() - new Date(item.startedAt).getTime()} ms` : 'pending'}</span></button>)}</div>
    <div className="min-w-0 space-y-3">{task && <><div className="flex flex-wrap gap-3 text-sm">{task.testRunId && <a className="text-blue-600" href={`/test-runs/${task.testRunId}`}>Open test results</a>}{detail.run.status === 'failed' && definition && canRetryNode(definition, task) && task.outputJson?.outcome !== 'unknown' && <button disabled={busy} onClick={() => action(`nodes/${task.nodeKey}/retry`)}>Retry failed node safely</button>}</div>{task.error && <p className="text-sm text-rose-700">{task.error}</p>}
    <details open><summary>Inputs (redacted)</summary><pre className="max-h-48 overflow-auto rounded bg-slate-50 p-3 text-xs">{JSON.stringify(task.inputJson, null, 2)}</pre></details><details open><summary>Outputs, assertions and evidence</summary><pre className="max-h-80 overflow-auto rounded bg-slate-50 p-3 text-xs">{JSON.stringify(task.outputJson, null, 2)}</pre></details>
    <div className="flex flex-wrap gap-3">{task.artifacts?.map((artifact: any) => <button className="text-sm text-blue-600" key={artifact.id} onClick={() => download(artifact.id)}>{artifact.type} · {artifact.id.slice(-8)}</button>)}</div></>}</div></div>
  </section>;
}
