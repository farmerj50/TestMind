export type SecurityValidationStatus =
  | "confirmed"
  | "likely"
  | "suspected"
  | "inconclusive"
  | "not_exploitable"
  | "false_positive"
  | "not_applicable";

export type SecurityValidationRequirement = {
  id: string;
  label: string;
  passed: boolean | null;
};

export type SecurityValidationProofLevel = "passive" | "protocol" | "browser" | "cross_identity" | "repeated";

export type SecurityValidation = {
  status: SecurityValidationStatus;
  confidence: number;
  proofLevel: SecurityValidationProofLevel;
  attempts: number;
  successfulReproductions: number;
  requirements: SecurityValidationRequirement[];
  expectedBehavior: string;
  observedBehavior: string;
  conclusion: string;
};

export function buildValidation(input: SecurityValidation): SecurityValidation {
  return {
    ...input,
    confidence: Math.max(0, Math.min(100, Math.round(input.confidence))),
  };
}
