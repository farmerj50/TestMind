export type ConfidenceBreakdownItem = {
  delta: number;
  reason: string;
};

export type SelectorConfidenceEvidence = {
  uniqueCount?: number | null;
  hasStableRoleName?: boolean;
  hasHref?: boolean;
  hasStableLabel?: boolean;
  passedInRun?: boolean;
};

export type SelectorConfidence = {
  score: number;
  breakdown: ConfidenceBreakdownItem[];
};

const clampScore = (value: number) => Math.max(0, Math.min(100, Math.round(value)));

const hasDynamicTextPattern = (normalized: string) => {
  if (!/text=|:has-text\(|getbytext\(/i.test(normalized)) return false;
  if (/\d/.test(normalized)) return true;
  if (/(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(normalized)) return true;
  if (/\b(today|yesterday|tomorrow)\b/i.test(normalized)) return true;
  return false;
};

export function scoreSelectorConfidence(
  selector: string,
  evidence?: SelectorConfidenceEvidence
): SelectorConfidence {
  const normalized = selector.trim().toLowerCase();
  const breakdown: ConfidenceBreakdownItem[] = [];
  let score = 25; // neutral baseline

  if (/data-testid|getbytestid|testid=/.test(normalized)) {
    score += 40;
    breakdown.push({ delta: 40, reason: "data-testid present" });
  }
  if (evidence?.uniqueCount === 1) {
    score += 25;
    breakdown.push({ delta: 25, reason: "unique selector on page" });
  }
  if (evidence?.hasStableRoleName || (/getbyrole|role=/.test(normalized) && /name=/.test(normalized))) {
    score += 15;
    breakdown.push({ delta: 15, reason: "stable role/name match" });
  }
  if (evidence?.hasHref) {
    score += 10;
    breakdown.push({ delta: 10, reason: "stable href evidence" });
  }
  if (evidence?.hasStableLabel) {
    score += 8;
    breakdown.push({ delta: 8, reason: "stable label evidence" });
  }
  if (evidence?.passedInRun) {
    score += 6;
    breakdown.push({ delta: 6, reason: "passed in recent run" });
  }
  if (/nth-child|:nth-|>.*>.*>/.test(normalized)) {
    score -= 30;
    breakdown.push({ delta: -30, reason: "nth-child or deep CSS chain" });
  }
  if (hasDynamicTextPattern(normalized)) {
    score -= 20;
    breakdown.push({ delta: -20, reason: "dynamic text pattern" });
  }
  if (breakdown.length === 0) {
    breakdown.push({ delta: 0, reason: "baseline" });
  }
  return { score: clampScore(score), breakdown };
}

