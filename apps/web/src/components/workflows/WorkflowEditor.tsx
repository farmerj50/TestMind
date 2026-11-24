import { useEffect, useMemo, useRef, useState } from 'react';
import { ReactFlow, ReactFlowProvider, Background, Controls, MiniMap, Handle, Position, applyNodeChanges, useReactFlow, type NodeProps, type Connection } from '@xyflow/react';
import { AUTONOMY_LEVELS, NODE_DEFINITIONS, getNodeDefinition, canConnectTypes, validateGraph, type WorkflowGraph, type InputBinding } from '@testmind/core/workflow';
import { newNode, nodeId, workflowTemplate } from './graph-model';
import '@xyflow/react/dist/style.css';
import './workflow-editor.css';

export function JsonField({ label, value, onChange }: { label: string; value: unknown; onChange(value: any): void }) {
  const [draft, setDraft] = useState(JSON.stringify(value, null, 2));
  const [error, setError] = useState('');
  const emitted = useRef(JSON.stringify(value));
  useEffect(() => { if (JSON.stringify(value) !== emitted.current) { setDraft(JSON.stringify(value, null, 2)); setError(''); emitted.current = JSON.stringify(value); } }, [value]);
  return <label className="wf-field">{label}<textarea aria-label={label} spellCheck={false} value={draft ?? ''} onChange={event => { setDraft(event.target.value); try { const parsed = JSON.parse(event.target.value); emitted.current = JSON.stringify(parsed); setError(''); event.target.setCustomValidity(''); onChange(parsed); } catch { setError('Enter valid JSON.'); event.target.setCustomValidity('Enter valid JSON.'); } }} />{error && <span role="alert">{error}</span>}</label>;
}
function GraphNode({ data, selected }: NodeProps) {
  const node = data.node as WorkflowGraph['nodes'][number];
  const definition = getNodeDefinition(node.type, node.version)!;
  const status = data.status as string | undefined;
  return <div className={`wf-node ${selected ? 'wf-selected' : ''} wf-${status ?? 'idle'}`}>
    <div className="wf-node-heading"><span>{node.name || definition.title}</span><small>{status ?? definition.category}</small></div>
    {node.type !== 'start' && <div className="wf-port"><Handle type="target" id="exec" position={Position.Left} />Execute</div>}
    {definition.branches.map(branch => <div className="wf-port wf-output" key={branch}>{branch}<Handle type="source" id={`exec:${branch}`} position={Position.Right} /></div>)}
    {Object.entries(definition.inputs).map(([key, port]) => <div className="wf-port wf-data" key={key}><Handle type="target" id={`in:${key}`} position={Position.Left} />{key}<small>{port.type}{port.required ? ' *' : ''}</small></div>)}
    {Object.entries(definition.outputs).map(([key, type]) => <div className="wf-port wf-output wf-data" key={key}>{key}<small>{type}</small><Handle type="source" id={`out:${key}`} position={Position.Right} /></div>)}
  </div>;
}
const nodeTypes = { workflow: GraphNode };
type Props = { graph: WorkflowGraph; onChange(graph: WorkflowGraph): void; statuses?: Record<string, string>; onDebug?(nodeId: string): void };
function Editor({ graph, onChange, statuses = {}, onDebug }: Props) {
  const [selected, setSelected] = useState<string>();
  const [selectedEdge, setSelectedEdge] = useState<string>();
  const [search, setSearch] = useState('');
  // Keep React Flow's measurements across parent/form renders. Dropping them
  // makes controlled nodes hidden until a resize that may never occur.
  const [measurements, setMeasurements] = useState<Record<string, { width: number; height: number }>>({});
  const [past, setPast] = useState<WorkflowGraph[]>([]), [future, setFuture] = useState<WorkflowGraph[]>([]);
  const dragStart = useRef<WorkflowGraph | undefined>(undefined);
  const { screenToFlowPosition, fitView } = useReactFlow();
  const validation = useMemo(() => validateGraph(graph), [graph]);
  const commit = (next: WorkflowGraph) => { setPast(history => [...history.slice(-49), graph]); setFuture([]); onChange(next); };
  const current = graph.nodes.find(node => node.id === selected);
  const definition = current && getNodeDefinition(current.type, current.version);
  const update = (patch: Partial<WorkflowGraph['nodes'][number]>) => current && commit({ ...graph, nodes: graph.nodes.map(node => node.id === current.id ? { ...node, ...patch } : node) });
  const remove = (ids: string[]) => commit({ ...graph, nodes: graph.nodes.filter(node => !ids.includes(node.id)), edges: graph.edges.filter(edge => !ids.includes(edge.source) && !ids.includes(edge.target)) });
  const nodes = graph.nodes.map(node => ({ id: node.id, type: 'workflow', position: node.position, measured: measurements[node.id], selected: selected === node.id, data: { node, status: statuses[node.id] } }));
  const edges = [...graph.edges.map(edge => ({ ...edge, sourceHandle: `exec:${edge.branch}`, targetHandle: 'exec', label: edge.branch })), ...graph.nodes.flatMap(node => Object.entries(node.inputs).flatMap(([port, binding]) => binding.kind === 'output' ? [{ id: `data-${node.id}-${port}`, source: binding.nodeId, target: node.id, sourceHandle: `out:${binding.port}`, targetHandle: `in:${port}`, label: `${binding.port} → ${port}`, style: { stroke: '#7c3aed', strokeDasharray: '5 4' } }] : []))];
  function connect(connection: Connection) {
    const source = graph.nodes.find(node => node.id === connection.source), target = graph.nodes.find(node => node.id === connection.target);
    if (!source || !target || source.id === target.id) return;
    if (connection.sourceHandle?.startsWith('exec:') && connection.targetHandle === 'exec') {
      const branch = connection.sourceHandle.slice(5);
      if (!graph.edges.some(edge => edge.source === source.id && edge.target === target.id && edge.branch === branch)) commit({ ...graph, edges: [...graph.edges, { id: nodeId(), source: source.id, target: target.id, branch }] });
    } else if (connection.sourceHandle?.startsWith('out:') && connection.targetHandle?.startsWith('in:')) {
      const output = connection.sourceHandle.slice(4), input = connection.targetHandle.slice(3);
      const outputType = getNodeDefinition(source.type)!.outputs[output], inputType = getNodeDefinition(target.type)!.inputs[input].type;
      if (canConnectTypes(outputType, inputType)) commit({ ...graph, nodes: graph.nodes.map(node => node.id === target.id ? { ...node, inputs: { ...node.inputs, [input]: { kind: 'output', nodeId: source.id, port: output } } } : node) });
    }
  }
  function add(type: string, position = screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 })) {
    const node = newNode(type, position); commit({ ...graph, nodes: [...graph.nodes, node] }); setSelected(node.id);
  }
  function removeConnection(id: string) {
    commit({ ...graph, edges: graph.edges.filter(edge => edge.id !== id), nodes: graph.nodes.map(node => ({ ...node, inputs: Object.fromEntries(Object.entries(node.inputs).filter(([key]) => `data-${node.id}-${key}` !== id)) })) });
    setSelectedEdge(undefined);
  }
  function bindingInput(key: string, binding: InputBinding | undefined) {
    const set = (value: InputBinding) => update({ inputs: { ...current!.inputs, [key]: value } });
    const port = definition!.inputs[key];
    return <div className="wf-binding" key={key}><label>{key} <small>{port.type}{port.required ? ' (required)' : ''}</small><select aria-label={`${key} source`} value={binding?.kind ?? ''} onChange={event => {
      const kind = event.target.value as InputBinding['kind'];
      if (!kind) { const inputs = { ...current!.inputs }; delete inputs[key]; update({ inputs }); }
      else set(kind === 'constant' ? { kind, value: '' } : kind === 'output' ? { kind, nodeId: '', port: '' } : { kind, key: '' });
    }}><option value="">Unset</option><option value="constant">Constant</option><option value="variable">Workflow variable</option><option value="environment">Environment variable</option>{port.secret && <option value="secret">Project secret</option>}<option value="output">Node output</option></select></label>
    {binding?.kind === 'constant' && (port.type === 'string' ? <input aria-label={`${key} value`} value={String(binding.value ?? '')} onChange={event => set({ kind: 'constant', value: event.target.value })} /> : <JsonField key={`${current!.id}-${key}-${binding.kind}`} label={`${key} value`} value={binding.value} onChange={value => set({ kind: 'constant', value })} />)}
    {binding && ['variable', 'environment', 'secret'].includes(binding.kind) && <input aria-label={`${key} reference`} placeholder="Reference name" value={'key' in binding ? binding.key : ''} onChange={event => set({ kind: binding.kind as 'variable', key: event.target.value })} />}
    {binding?.kind === 'output' && <select aria-label={`${key} output`} value={`${binding.nodeId}.${binding.port}`} onChange={event => { const [nodeId, port] = event.target.value.split('|'); set({ kind: 'output', nodeId, port }); }}><option value={`${binding.nodeId}.${binding.port}`}>{binding.nodeId ? `${binding.nodeId}.${binding.port}` : 'Choose output'}</option>{graph.nodes.filter(node => node.id !== current!.id).flatMap(node => Object.entries(getNodeDefinition(node.type)!.outputs).filter(([, type]) => canConnectTypes(type, port.type)).map(([out]) => <option key={`${node.id}.${out}`} value={`${node.id}|${out}`}>{node.name || node.id} · {out}</option>))}</select>}
    </div>;
  }
  return <div className="wf-builder" onKeyDownCapture={event => { if (selectedEdge && ['Delete', 'Backspace'].includes(event.key) && !['INPUT', 'TEXTAREA', 'SELECT'].includes((event.target as HTMLElement).tagName)) { event.preventDefault(); event.stopPropagation(); removeConnection(selectedEdge); } }}>
    <div className="wf-toolbar"><button type="button" disabled={!past.length} onClick={() => { const previous = past[past.length - 1]; setFuture([graph, ...future]); setPast(past.slice(0, -1)); onChange(previous); }}>Undo</button><button type="button" disabled={!future.length} onClick={() => { setPast([...past, graph]); onChange(future[0]); setFuture(future.slice(1)); }}>Redo</button><button type="button" onClick={() => fitView()}>Fit view</button>
    <label>Autonomy <select aria-label="Autonomy level" value={graph.autonomy} onChange={event => commit({ ...graph, autonomy: event.target.value as WorkflowGraph['autonomy'] })}>{AUTONOMY_LEVELS.map(level => <option key={level} value={level}>{level.replaceAll('-', ' ')}</option>)}</select></label>
    <select aria-label="Workflow template" defaultValue="" onChange={event => { commit(workflowTemplate(event.target.value)); setSelected(undefined); event.target.value = ''; }}><option value="" disabled>Load template…</option><option value="api">API smoke test</option><option value="ui">UI discovery and tests</option><option value="autonomous">Autonomous QA</option></select>
    <span role="status">{validation.valid ? 'Graph valid' : `${validation.errors.length} validation issue(s)`}</span></div>
    {selectedEdge && <div className="wf-toolbar"><span>Connection selected</span><button type="button" onClick={() => removeConnection(selectedEdge)}>Remove connection</button></div>}
    <div className="wf-layout"><aside className="wf-palette"><h3>Add node</h3><input aria-label="Search nodes" placeholder="Search nodes…" value={search} onChange={event => setSearch(event.target.value)} />{NODE_DEFINITIONS.filter(node => `${node.title} ${node.category}`.toLowerCase().includes(search.toLowerCase())).map(node => <button type="button" draggable key={node.type} onDragStart={event => event.dataTransfer.setData('application/testmind-node', node.type)} onClick={() => add(node.type)}><strong>{node.title}</strong><small>{node.category}</small></button>)}
    <details><summary>Variables and limits</summary><JsonField label="Workflow variables" value={graph.variables} onChange={variables => commit({ ...graph, variables })} /><JsonField label="Execution limits" value={graph.limits} onChange={limits => commit({ ...graph, limits })} /></details></aside>
    <div className="wf-canvas" onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; }} onDrop={event => { event.preventDefault(); const type = event.dataTransfer.getData('application/testmind-node'); if (getNodeDefinition(type)) add(type, screenToFlowPosition({ x: event.clientX, y: event.clientY })); }}>
    <ReactFlow nodes={nodes} edges={edges.map(edge => ({ ...edge, selected: selectedEdge === edge.id }))} nodeTypes={nodeTypes} deleteKeyCode={['Backspace', 'Delete']} fitView onConnect={connect} onNodeClick={(_event, node) => { setSelected(node.id); setSelectedEdge(undefined); }} onEdgeClick={(_event, edge) => { setSelectedEdge(edge.id); setSelected(undefined); }} onPaneClick={() => { setSelected(undefined); setSelectedEdge(undefined); }}
      onNodeDragStart={() => { dragStart.current = graph; }} onNodeDragStop={() => { if (dragStart.current) { setPast(history => [...history.slice(-49), dragStart.current!]); setFuture([]); dragStart.current = undefined; } }}
      onNodesChange={changes => { const dimensions = changes.filter(change => change.type === 'dimensions'); if (dimensions.length) setMeasurements(previous => { const next = { ...previous }; let changed = false; for (const change of dimensions) if (change.dimensions && (next[change.id]?.width !== change.dimensions.width || next[change.id]?.height !== change.dimensions.height)) { next[change.id] = change.dimensions; changed = true; } return changed ? next : previous; }); const removed = changes.filter(change => change.type === 'remove'); if (removed.length) { remove(removed.map(change => change.id)); return; } if (!changes.some(change => change.type === 'position')) return; const positioned = applyNodeChanges(changes, nodes); onChange({ ...graph, nodes: graph.nodes.map(node => ({ ...node, position: positioned.find(item => item.id === node.id)?.position ?? node.position })) }); }}
      onEdgesDelete={deleted => { const ids = new Set(deleted.map(edge => edge.id)); commit({ ...graph, edges: graph.edges.filter(edge => !ids.has(edge.id)), nodes: graph.nodes.map(node => ({ ...node, inputs: Object.fromEntries(Object.entries(node.inputs).filter(([key]) => !ids.has(`data-${node.id}-${key}`))) })) }); }}><Background /><Controls /><MiniMap /></ReactFlow>
    </div><aside className="wf-properties">{current && definition ? <><h3>Node configuration</h3><label className="wf-field">Name<input aria-label="Node name" value={current.name ?? ''} onChange={event => update({ name: event.target.value })} /></label><small>{current.type} · v{current.version}</small><div className="wf-actions"><button type="button" onClick={() => { const copy = { ...structuredClone(current), id: nodeId(), position: { x: current.position.x + 40, y: current.position.y + 60 } }; commit({ ...graph, nodes: [...graph.nodes, copy] }); setSelected(copy.id); }}>Duplicate</button><button type="button" onClick={() => remove([current.id])}>Remove node</button>{onDebug && <button type="button" onClick={() => onDebug(current.id)}>Execute node</button>}</div>
      {current.type === 'python.script' && <p>Define main(inputs) and return JSON. Declare each input below; bind its value in the values object. Secret inputs are unsupported. Execution requires an enabled, verified Python sandbox.</p>}
      {Object.entries(definition.configSchema.properties ?? {}).map(([key, raw]) => { const schema = raw as any; const value = current.config[key]; return current.type === 'python.script' && key === 'script' ? <label className="wf-field" key={key}>Python script<textarea aria-label="Python script" rows={12} spellCheck={false} value={String(value ?? '')} onChange={event => update({ config: { ...current.config, script: event.target.value } })} /></label> : schema.enum ? <label className="wf-field" key={key}>{key}<select aria-label={key} value={String(value ?? '')} onChange={event => update({ config: { ...current.config, [key]: event.target.value } })}>{schema.enum.map((item: string) => <option key={item}>{item}</option>)}</select></label> : ['string', 'integer', 'number'].includes(schema.type) ? <label className="wf-field" key={key}>{key}<input aria-label={key} type={schema.type === 'string' ? 'text' : 'number'} value={String(value ?? '')} min={schema.minimum} max={schema.maximum} onChange={event => update({ config: { ...current.config, [key]: schema.type === 'string' ? event.target.value : Number(event.target.value) } })} /></label> : <JsonField key={`${current.id}-${key}`} label={key} value={value} onChange={value => update({ config: { ...current.config, [key]: value } })} />; })}
      <h4>Input bindings</h4>{Object.keys(definition.inputs).map(key => bindingInput(key, current.inputs[key]))}</> : <><h3>Build a workflow</h3><p>Add or drag a node onto the canvas. Connect execution ports to set the order, and purple data ports to pass values.</p><p>Select a node to configure inputs. Select a connection and press Delete to remove it.</p></>}</aside></div>
    {!validation.valid && <ul className="wf-errors" aria-label="Graph validation errors">{validation.errors.map((error, index) => <li key={index}><button type="button" onClick={() => setSelected(error.nodeId)}>{error.nodeId ? `${error.nodeId}: ` : ''}{error.message}</button></li>)}</ul>}
  </div>;
}
export default function WorkflowEditor(props: Props) { return <ReactFlowProvider><Editor {...props} /></ReactFlowProvider>; }
