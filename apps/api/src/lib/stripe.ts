import Stripe from "stripe";
import { validatedEnv } from "../config/env.js";

const key = validatedEnv.STRIPE_SECRET_KEY?.trim();

export const stripe = key
  ? new Stripe(key, {
      apiVersion: "2024-06-20",
    })
  : null;

export function requireStripe() {
  if (!stripe) {
    throw new Error("STRIPE_SECRET_KEY is not configured.");
  }
  return stripe;
}
