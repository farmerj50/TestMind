// apps/api/src/testmind/validate.ts
import type { TestPlan, Discovery, TestCase } from './core/plan'; // <-- path is correct for this file location

/**
 * Lightweight validation for a generated plan.
 * - At least 1 test case
 * - For each discovered form: has a "Negative required" and a "Boundary values" case
 */
export function validatePlan(
  plan: TestPlan,
  opts?: { discovery?: Discovery }
): { ok: boolean; issues: string[] } {
  const issues: string[] = [];
  const cases: TestCase[] = plan.cases ?? [];

  if (cases.length < 1) {
    issues.push('Plan has no test cases');
  }

  const disc = opts?.discovery;
  if (disc?.forms && Array.isArray(disc.forms)) {
    for (const f of disc.forms) {
      const label = f.selector ?? 'form';

      const hasNegative = cases.some((tc: TestCase) =>
  (tc as any).name?.includes('Negative required') && (tc as any).name?.includes(label)
);
      if (!hasNegative) {
        issues.push(`Form ${label} missing negative-required case`);
      }

      const hasBoundary = cases.some((tc: TestCase) =>
  (tc as any).name?.includes('Boundary values') && (tc as any).name?.includes(label)
);
      if (!hasBoundary) {
        issues.push(`Form ${label} missing boundary case`);
      }
    }
  }

  return { ok: issues.length === 0, issues };
}
