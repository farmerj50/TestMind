// ✅ Reuse canonical test types from pattern.ts
import type { TestCase, Step } from "./pattern.js";

export type Persona = "manual" | "sdet" | "automation";

export interface Env {
  baseUrl?: string;
}

// High-level “thing” we’re testing
export interface Component {
  id: string;
  type: "UI" | "API" | "Service";
  paths?: string[]; // e.g., ['/checkout', '/login']
}

export interface Requirement {
  id: string;
  title: string;
  priority: "P0" | "P1" | "P2";
}

// Discovery artifacts (keep if you use them elsewhere)
export interface FormFieldMeta {
  name: string;
  type?: string;
  required?: boolean;
  min?: number;
  max?: number;
  pattern?: string;
}
export interface FormMeta {
  selector: string;
  action?: string;
  fields: FormFieldMeta[];
  routeHint?: string;
}
export interface ApiMeta {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  auth?: boolean;
}
export interface Discovery {
  routes: string[];
  forms: FormMeta[];
  apis: ApiMeta[];
}

// ✅ Canonical plan type (matches writer/emitter)
export interface TestPlan {
  baseUrl: string;
  cases: TestCase[];      // what writer/emitter consume
  testCases?: TestCase[]; // optional back-compat
  meta?: Record<string, any>;
}

// Optional convenience re-exports so other files can import from plan.ts
export type { TestCase, Step };
