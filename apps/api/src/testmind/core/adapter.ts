// apps/api/src/testmind/core/adapter.ts
import { TestPlan } from './plan';
export type RenderedFile = { path: string; content: string; };
export interface TestAdapter {
  id: string;                       // e.g., 'playwright-ts', 'cypress-js'
  displayName: string;              // UI label
  render(plan: TestPlan): RenderedFile[];  // writeable files
  manifest(plan: TestPlan): any;    // metadata for UI
}

// apps/api/src/testmind/core/runner.ts
export interface TestRunner {
  id: string; // same as adapter.id or a variant
  install?(cwd: string): Promise<void>; // optional adapter-level install
  run(cwd: string, env: Record<string,string>, onLine: (line:string)=>void): Promise<number>;
}
