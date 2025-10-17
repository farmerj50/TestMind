// apps/api/src/testmind/core/plan.ts

export type Persona = 'manual' | 'sdet' | 'automation';

export interface Env {
  baseUrl?: string;
}

// High-level “thing” we’re testing
export interface Component {
  id: string;
  type: 'UI' | 'API' | 'Service';
  paths?: string[]; // e.g., ['/checkout', '/login']
}

export interface Requirement {
  id: string;
  title: string;
  priority: 'P0' | 'P1' | 'P2';
}

// Discovery artifacts
export interface FormFieldMeta {
  name: string;
  type?: string;
  required?: boolean;
  min?: number;
  max?: number;
  pattern?: string;
}

export interface FormMeta {
  selector: string;       // CSS for the <form> or container
  action?: string;        // optional action URL
  fields: FormFieldMeta[];
  routeHint?: string;     // page/route this form lives on
}

export interface ApiMeta {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  auth?: boolean;
}

export interface Discovery {
  routes: string[];
  forms: FormMeta[];
  apis: ApiMeta[];
}

// ---------------- test model (ALIGN WITH PATTERNS + CODEGEN) ----------------

export type Step =
  | { kind: 'goto'; url: string }
  | { kind: 'click'; by: 'text' | 'selector' | 'role' | 'label'; value: string }
  // note: fill must have by/value/text
  | { kind: 'fill'; by: 'label' | 'selector'; value: string; text: string }
  | { kind: 'expectVisible'; by: 'text' | 'selector'; value: string }
  | { kind: 'apiCall'; method: string; path: string; expectStatus: number }
  | { kind: 'waitForIdle' }
  | { kind: 'assert'; expr: string; message?: string };

export type CaseGroup = {
  page?: string;                // e.g. "/pricing"
  feature?: string;             // e.g. "navbar", "forms"
  type?: string;                // e.g. "happy", "negative", "boundary"
  priority?: 'P0' | 'P1' | 'P2';
};

export interface TestCase {
  id: string;
  title: string;
  steps: Step[];
  // traceability
  requirementIds?: string[];
  componentId?: string;
  // grouping for page-based codegen
  group?: CaseGroup;
  tags?: string[];
}

export interface TestPlan {
  baseUrl: string;
  // keep both, but prefer `cases`
  cases: TestCase[];
  testCases?: TestCase[]; // <— optional, legacy
  components?: Component[];          // make these optional if you like
  requirements?: Requirement[];      // "
  meta?: Record<string, any>;
}


