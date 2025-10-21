import type { $Enums } from "@prisma/client";

export type PlanTier = $Enums.PlanTier;

const envInt = (k: string, d: number) => {
  const v = parseInt(process.env[k] ?? "", 10);
  return Number.isFinite(v) ? v : d;
};

export type PlanLimits = {
  maxProjects: number;
  dailyRuns: number;   // max test runs in a rolling 24h window
  maxCases: number;    // total test cases per account (soft cap)
};

export const PLAN_LIMITS: Record<PlanTier, PlanLimits> = {
  free: {
    maxProjects: envInt("FREE_MAX_PROJECTS", 1),
    dailyRuns:   envInt("FREE_DAILY_RUNS", 20),
    maxCases:    envInt("FREE_MAX_CASES", 500),
  },
  pro: {
    maxProjects: envInt("PRO_MAX_PROJECTS", 50),
    dailyRuns:   envInt("PRO_DAILY_RUNS", 5000),
    maxCases:    envInt("PRO_MAX_CASES", 250000),
  },
  enterprise: {
    maxProjects: envInt("ENT_MAX_PROJECTS", 1000),
    dailyRuns:   envInt("ENT_DAILY_RUNS", 100000),
    maxCases:    envInt("ENT_MAX_CASES", 1000000),
  },
};

export function getLimitsForPlan(plan: PlanTier) {
  return PLAN_LIMITS[plan];
}
