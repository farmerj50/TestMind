import { validatedEnv } from "./env.js";

export const STRIPE_PRICE_IDS = {
  starter: validatedEnv.STRIPE_PRICE_STARTER ?? "price_1SiaIHAXNErPx5kN2QcB9UcK",
  pro: validatedEnv.STRIPE_PRICE_PRO ?? "price_1SiaImAXNErPx5kNfLJKTGLH",
  team: validatedEnv.STRIPE_PRICE_TEAM ?? "price_1SiaJ9AXNErPx5kNkFzZjArN",
} as const;

export const PAID_PLANS = ["starter", "pro", "team"] as const;
export type PaidPlan = (typeof PAID_PLANS)[number];
