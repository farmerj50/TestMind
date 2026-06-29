import { Redis, type RedisOptions } from 'ioredis';
import { validatedEnv } from "../config/env.js";

const REDIS_URL = validatedEnv.REDIS_URL;

function logRedisError(scope: string, err: Error & { code?: string }) {
  const code = err.code ? ` ${err.code}` : "";
  console.warn(`[redis:${scope}]${code} ${err.message}`);
}

export function createRedisConnection(scope = "worker", options: RedisOptions = {}) {
  const connection = new Redis(REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: null,
    ...options,
  });
  connection.on("error", (err) => logRedisError(scope, err as Error & { code?: string }));
  return connection;
}

export function createQueueRedisConnection(scope = "queue") {
  return createRedisConnection(scope, {
    connectTimeout: 5_000,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
  });
}

export const redis = createRedisConnection();
