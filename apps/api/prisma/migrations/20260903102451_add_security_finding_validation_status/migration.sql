-- CreateEnum
CREATE TYPE "SecurityFindingValidationStatus" AS ENUM ('confirmed', 'likely', 'suspected', 'inconclusive', 'not_exploitable', 'false_positive', 'not_applicable');

-- AlterTable
ALTER TABLE "SecurityFinding" ADD COLUMN     "validationStatus" "SecurityFindingValidationStatus";

