import type { ConfidenceBreakdownItem } from './selector-confidence.js';

export type AuthEntryCandidate = {
  selector: string;
  text: string;
  tag: string;
  role?: string;
  href?: string;
  ariaLabel?: string;
  testId?: string;
};

export type AuthEntryScore = {
  score: number;
  breakdown: ConfidenceBreakdownItem[];
};

const clampScore = (value: number) => Math.max(0, Math.min(100, Math.round(value)));

// Matches the *whole* accessible text, e.g. a button that says exactly "Sign In" —
// this is the strongest signal since it's how a real user would recognize the control.
const EXACT_AUTH_TEXT_RE = /^(sign in|log in|login|signin|sign into account|sign-in)$/i;

// Matches auth wording anywhere in a longer label, e.g. "Sign In ->" or "Member Sign In".
const LOOSE_AUTH_TEXT_RE = /\b(sign in|log in|login|signin)\b/i;

const AUTH_HREF_RE = /\/(login|signin|sign-in|auth|sso|account\/login)/i;

// Matches auth wording inside an id-like string (data-testid, aria-label) —
// e.g. "landing-sign-in-btn" — where words are joined by dashes/underscores
// rather than spaces, so the text-based regexes above won't match it.
const AUTH_ID_RE = /sign[-_]?in|log[-_]?in|login/i;

export function scoreAuthEntryCandidate(candidate: AuthEntryCandidate): AuthEntryScore {
  const breakdown: ConfidenceBreakdownItem[] = [];
  let score = 10; // low neutral baseline — a candidate has to earn its way up

  const text = candidate.text.trim();

  if (EXACT_AUTH_TEXT_RE.test(text)) {
    score += 50;
    breakdown.push({ delta: 50, reason: 'exact auth-entry text match' });
  } else if (LOOSE_AUTH_TEXT_RE.test(text)) {
    score += 30;
    breakdown.push({ delta: 30, reason: 'partial auth-entry text match' });
  }

  if (candidate.role === 'button' || candidate.tag === 'button') {
    score += 10;
    breakdown.push({ delta: 10, reason: 'button role' });
  } else if (candidate.tag === 'a' && candidate.href) {
    score += 8;
    breakdown.push({ delta: 8, reason: 'link with href' });
  }

  if (candidate.href && AUTH_HREF_RE.test(candidate.href)) {
    score += 15;
    breakdown.push({ delta: 15, reason: 'href suggests an auth route' });
  }

  if (candidate.testId && AUTH_ID_RE.test(candidate.testId)) {
    score += 25;
    breakdown.push({ delta: 25, reason: 'data-testid suggests an auth control' });
  }

  if (candidate.ariaLabel && AUTH_ID_RE.test(candidate.ariaLabel)) {
    score += 20;
    breakdown.push({ delta: 20, reason: 'aria-label suggests an auth control' });
  }

  if (!text && !candidate.ariaLabel && !candidate.testId) {
    score -= 25;
    breakdown.push({ delta: -25, reason: 'no accessible text' });
  } else if (text.length > 30) {
    score -= 15;
    breakdown.push({ delta: -15, reason: 'text too long for a nav control' });
  }

  if (breakdown.length === 0) {
    breakdown.push({ delta: 0, reason: 'baseline' });
  }

  return { score: clampScore(score), breakdown };
}

export function rankAuthEntryCandidates(
  candidates: AuthEntryCandidate[]
): Array<AuthEntryCandidate & AuthEntryScore> {
  return candidates
    .map((candidate) => ({ candidate, scored: scoreAuthEntryCandidate(candidate) }))
    .sort((a, b) => b.scored.score - a.scored.score)
    .map(({ candidate, scored }) => ({ ...candidate, ...scored }));
}
