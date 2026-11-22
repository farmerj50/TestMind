import React from 'react';
import { createRoot } from 'react-dom/client';
import WorkflowsPage from '../../apps/web/src/pages/WorkflowsPage';
import '../../apps/web/src/index.css';
createRoot(document.getElementById('root')!).render(<WorkflowsPage />);
