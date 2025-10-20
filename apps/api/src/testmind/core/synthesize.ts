import { discoverSite } from "../discover.js";
import { generatePlan } from "../pipeline/generate-plan.js";
import { writeSpecsFromPlan } from "../pipeline/codegen.js"; 
import path from "node:path";
import type {
  Env as EnvT,
  Component as ComponentT,
  Requirement as RequirementT,
  Persona as PersonaT,
} from "./plan.js";

export async function runOnce(params: {
  baseUrl: string;
  persona?: PersonaT;
  project?: string; // slug for output folder
}) {
  const { baseUrl, persona = "sdet", project = "default" } = params;
  if (!baseUrl) throw new Error("baseUrl is required");

  const env: EnvT = { baseUrl };
  const component: ComponentT = { id: project, type: "UI" };
  const requirement: RequirementT = { id: "R1", title: "Generated plan", priority: "P1" };
  const risks = { likelihood: 0.3, impact: 0.5 };

  const discovered = await discoverSite(baseUrl);
  const patternInput = { component, requirement, risks, discovered, env };

  const plan = generatePlan(patternInput, persona);

  console.log("[tm] baseUrl:", baseUrl);
  console.log("[tm] routes:", discovered.routes.length);
  console.log("[tm] cases:", plan.cases.length);

  const outDir = path.resolve(
  process.cwd(),
  "src/testmind-generated/playwright-ts/tests"
);
await writeSpecsFromPlan(outDir, plan);

  return { routes: discovered.routes.length, cases: plan.cases.length };
}

// Optional: run from CLI for quick testing
if (import.meta.url === `file://${process.argv[1]}`) {
  runOnce({ baseUrl: process.env.TM_BASE_URL ?? "https://example.com", project: "cli" })
    .catch((e) => { console.error(e); process.exit(1); });
}


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

// Test model
export type Step =
  | { kind: 'goto'; url: string }
  | { kind: 'click'; by: 'text' | 'selector' | 'role' | 'label'; value: string }
  | { kind: 'fill'; selector: string; value: string }
  | { kind: 'expectVisible'; by: 'text' | 'selector'; value: string }
  | { kind: 'apiCall'; method: string; path: string; expectStatus: number }
  | { kind: 'waitForIdle' }
  | { kind: 'assert'; expr: string; message?: string };

export interface TestCase {
  id: string;
  title: string;
  steps: Step[];
  // traceability
  requirementIds?: string[];
  componentId?: string;
}

export interface TestPlan {
  baseUrl: string;
  components: Component[];
  requirements: Requirement[];
  testCases: TestCase[];
  meta?: Record<string, any>;
}
