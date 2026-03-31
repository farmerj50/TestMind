import { Redis } from 'ioredis';
import { validatedEnv } from "../config/env.js";

const REDIS_URL = validatedEnv.REDIS_URL;
export const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
