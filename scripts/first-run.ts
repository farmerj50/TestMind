import 'dotenv/config';
import { execSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
import { validatedEnv } from '../apps/api/src/config/env';

async function checkRedis(url: string) {
  const client = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 2 });
  try {
    await client.connect();
    await client.ping();
  } finally {
    await client.quit();
  }
}

async function checkPostgres(url: string) {
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  try {
    await prisma.$connect();
  } finally {
    await prisma.$disconnect();
  }
}

async function main() {
  console.log('first-run sanity: loading .env via apps/api config');
  console.log(`NODE_ENV=${validatedEnv.NODE_ENV}`);
  console.log('verifying Redis connection...');
  await checkRedis(validatedEnv.REDIS_URL);
  console.log('Redis reachable');
  console.log('verifying Postgres connection...');
  await checkPostgres(validatedEnv.DATABASE_URL);
  console.log('Postgres reachable');
  console.log('running pnpm install --frozen-lockfile');
  execSync('pnpm install --frozen-lockfile', { stdio: 'inherit' });
  console.log('pnpm dependencies are in sync');
}

main().catch((error) => {
  console.error('first-run sanity check failed');
  console.error(error);
  process.exit(1);
});
