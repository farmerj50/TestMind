// apps/worker/src/prisma.ts
import { PrismaClient, TestRunStatus } from '@prisma/client';
export const prisma = new PrismaClient();
export { TestRunStatus };
