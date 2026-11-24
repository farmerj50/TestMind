-- CreateTable: ResearchProgram existed in schema.prisma with no corresponding migration
-- anywhere in history (verified via `prisma migrate diff --from-url <empty-db> --to-schema-datamodel`).
CREATE TABLE "ResearchProgram" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "programRules" TEXT NOT NULL,
    "targetUrl" TEXT NOT NULL,
    "featureOrFlow" TEXT NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ResearchProgram_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ResearchProgram_userId_idx" ON "ResearchProgram"("userId");
