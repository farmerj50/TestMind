import { PrismaClient, TestRunStatus } from "@prisma/client";

export const prisma = new PrismaClient();
export { TestRunStatus };

