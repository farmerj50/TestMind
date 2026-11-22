import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import WorkflowEditor from '../../apps/web/src/components/workflows/WorkflowEditor';
import { workflowTemplate } from '../../apps/web/src/components/workflows/graph-model';

function Fixture() {
  const [graph, setGraph] = useState(() => JSON.parse(localStorage.getItem('workflow-fixture') || 'null') ?? workflowTemplate());
  (window as any).workflowGraph = graph;
  return <><button onClick={() => localStorage.setItem('workflow-fixture', JSON.stringify(graph))}>Save fixture</button><WorkflowEditor graph={graph} onChange={setGraph} /></>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
