import type { PlanTier } from "@prisma/client";
export type { PlanTier };

const envInt = (k: string, d: number) => {
  const v = parseInt(process.env[k] ?? "", 10);
  return Number.isFinite(v) ? v : d;
};

export type PlanLimits = {
  maxProjects: number;
  monthlyRuns: number; // max test runs per month
  maxCases: number;  // total test cases per account (soft cap)
};

export const PLAN_LIMITS: Record<PlanTier, PlanLimits> = {
  free: {
    maxProjects: envInt("FREE_MAX_PROJECTS", 1),
    monthlyRuns: envInt("FREE_MONTHLY_RUNS", 50),
    maxCases: envInt("FREE_MAX_CASES", 500),
  },
  starter: {
    maxProjects: envInt("STARTER_MAX_PROJECTS", 3),
    monthlyRuns: envInt("STARTER_MONTHLY_RUNS", 300),
    maxCases: envInt("STARTER_MAX_CASES", 3000),
  },
  pro: {
    maxProjects: envInt("PRO_MAX_PROJECTS", 10),
    monthlyRuns: envInt("PRO_MONTHLY_RUNS", 2000),
    maxCases: envInt("PRO_MAX_CASES", 20000),
  },
  team: {
    maxProjects: envInt("TEAM_MAX_PROJECTS", Number.MAX_SAFE_INTEGER),
    monthlyRuns: envInt("TEAM_MONTHLY_RUNS", 10000),
    maxCases: envInt("TEAM_MAX_CASES", 100000),
  },
};

export function getLimitsForPlan(plan: PlanTier) {
  return PLAN_LIMITS[plan];
}
