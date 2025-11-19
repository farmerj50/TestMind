// apps/worker/src/prisma.ts
import { PrismaClient, Prisma } from '@prisma/client';
export const prisma = new PrismaClient();
export const { TestRunStatus } = Prisma;
