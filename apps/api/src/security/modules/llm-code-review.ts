import path from "node:path";
import type { SecuritySeverity } from "../types.js";
import {
  requestSecurityReviewCandidates,
  requestSecurityReviewConfirmation,
  type SecurityReviewCandidate,
} from "../../runner/llm.js";

// Target Repo Security Review v1 (Contract A: TRS). Unlike security/modules/code-review.ts
// (hardcoded against TestMind's own ~19 source files), this module reviews an arbitrary
// project's own cloned repo via a two-pass LLM review: Pass 1 flags candidates from a single
// file in isolation, Pass 2 confirms/downgrades/discards each candidate given a small bounded
// set of related files - a single file can't establish whether middleware is applied globally,
// whether an ownership check happens in a service layer, or whether auth context comes from
// elsewhere. TRS.3 (wiring into runner/security-worker.ts, a separate pass) is responsible for
// cloning the repo and persisting the output of reviewRepoForVulnerabilities() as real
// SecurityFinding rows - this module stays Prisma-free, matching the pure/query/HTTP layering
// convention used elsewhere in this codebase (application-model.ts, autonomous-planner.ts).

// TRS v1 limits - frozen as literal constants per the contract, not implementation-time
// decisions.
export const MAX_REVIEW_FILES = 40;
export const MAX_REVIEW_BYTES = 500_000;
export const MAX_CONTEXT_FILES_PER_CANDIDATE = 4;
export const MAX_CONTEXT_BYTES_PER_CANDIDATE = 100_000;
export const MAX_CANDIDATES_PER_FILE = 5;
export const MIN_PERSIST_CONFIDENCE = 0.8;

export type FileEntry = { relativePath: string; size: number };
export type LoadedFile = { relativePath: string; content: string };

export type ConfirmedFinding = {
  title: string;
  severity: SecuritySeverity;
  vulnerabilityClass: string;
  location: string;
  description: string;
  suggestion: string;
  confidence: number;
};

const RELEVANT_PATH_PATTERNS = [/\/routes\//i, /\/controllers\//i, /\/api\//i, /\/middleware\//i, /auth/i];

/**
 * TRS.1 - pure, no IO. Picks a bounded, relevant set of files from a repo's file listing:
 * common route/controller/middleware/auth directories across frameworks, capped at
 * MAX_REVIEW_FILES / MAX_REVIEW_BYTES so review cost stays bounded regardless of repo size.
 * Deterministic (sorted by path) so the same file listing always selects the same files.
 */
export function selectFilesForReview(files: FileEntry[]): FileEntry[] {
  const relevant = files.filter((f) => RELEVANT_PATH_PATTERNS.some((pattern) => pattern.test(f.relativePath)));
  const sorted = [...relevant].sort((a, b) => a.relativePath.localeCompare(b.relativePath));

  const selected: FileEntry[] = [];
  let totalBytes = 0;
  for (const file of sorted) {
    if (selected.length >= MAX_REVIEW_FILES) break;
    if (totalBytes + file.size > MAX_REVIEW_BYTES) continue;
    selected.push(file);
    totalBytes += file.size;
  }
  return selected;
}

/**
 * A finding is never persisted unless lineStart/lineEnd point into the file that was actually
 * reviewed and are in range (TRS.2's safeguard).
 */
export function isLineRangeValid(content: string, lineStart: number, lineEnd: number): boolean {
  if (lineStart < 1 || lineEnd < lineStart) return false;
  const totalLines = content.split(/\r?\n/).length;
  return lineStart <= totalLines;
}

/**
 * Pass 2's bounded extra-context set: the candidate's own resolved relative imports (its
 * imported auth middleware, called service/repository module, etc., when those are pulled in
 * via a relative import) - capped at MAX_CONTEXT_FILES_PER_CANDIDATE /
 * MAX_CONTEXT_BYTES_PER_CANDIDATE. A deliberately bounded heuristic, not a full call-graph or
 * AST resolution - see the frozen TRS contract's "small bounded context set" wording.
 */
function extractRelativeImportSpecifiers(content: string): string[] {
  const specifiers = new Set<string>();
  const importRe = /(?:import\s+[\s\S]*?\s+from\s+|require\()\s*["'](\.[^"']+)["']/g;
  let match: RegExpExecArray | null;
  while ((match = importRe.exec(content)) !== null) {
    if (match[1]) specifiers.add(match[1]);
  }
  return Array.from(specifiers);
}

const RESOLVE_CANDIDATES = ["", ".ts", ".tsx", ".js", ".jsx", "/index.ts", "/index.tsx", "/index.js", "/index.jsx"];

function resolveImportToFile(
  candidateDir: string,
  specifier: string,
  loadFile: (relativePath: string) => LoadedFile | null
): LoadedFile | null {
  const base = path.posix.normalize(path.posix.join(candidateDir, specifier));
  for (const suffix of RESOLVE_CANDIDATES) {
    const loaded = loadFile(`${base}${suffix}`);
    if (loaded) return loaded;
  }
  return null;
}

function gatherContextFiles(
  candidateFileRelativePath: string,
  candidateFileContent: string,
  loadFile: (relativePath: string) => LoadedFile | null
): LoadedFile[] {
  const candidateDir = path.posix.dirname(candidateFileRelativePath.replace(/\\/g, "/"));
  const specifiers = extractRelativeImportSpecifiers(candidateFileContent);

  const context: LoadedFile[] = [];
  let totalBytes = 0;
  for (const specifier of specifiers) {
    if (context.length >= MAX_CONTEXT_FILES_PER_CANDIDATE) break;
    const resolved = resolveImportToFile(candidateDir, specifier, loadFile);
    if (!resolved) continue;
    if (totalBytes + resolved.content.length > MAX_CONTEXT_BYTES_PER_CANDIDATE) continue;
    context.push(resolved);
    totalBytes += resolved.content.length;
  }
  return context;
}

export type ReviewRepoParams = {
  projectId?: string;
  /** Every file under the checked-out repo, relative path + byte size - no content read yet. */
  listFiles: () => FileEntry[];
  /** Reads one file's content by relative path; returns null if it doesn't exist/can't be read. */
  loadFile: (relativePath: string) => LoadedFile | null;
  /** Injectable for TRS.4's deterministic certification - defaults to the real LLM call. */
  reviewCandidates?: typeof requestSecurityReviewCandidates;
  /** Injectable for TRS.4's deterministic certification - defaults to the real LLM call. */
  reviewConfirmation?: typeof requestSecurityReviewConfirmation;
};

/**
 * TRS.2's full two-pass orchestration. Returns only confirmed, in-range, sufficiently-confident
 * findings, ready for the caller (TRS.3, in runner/security-worker.ts) to persist as real
 * SecurityFinding rows - this function itself never touches Prisma.
 */
export async function reviewRepoForVulnerabilities(params: ReviewRepoParams): Promise<ConfirmedFinding[]> {
  const reviewCandidates = params.reviewCandidates ?? requestSecurityReviewCandidates;
  const reviewConfirmation = params.reviewConfirmation ?? requestSecurityReviewConfirmation;

  const selectedFiles = selectFilesForReview(params.listFiles());
  const confirmed: ConfirmedFinding[] = [];

  for (const fileEntry of selectedFiles) {
    const file = params.loadFile(fileEntry.relativePath);
    if (!file) continue;

    let candidates: SecurityReviewCandidate[];
    try {
      const res = await reviewCandidates({ projectId: params.projectId, relativePath: file.relativePath, content: file.content });
      candidates = res.candidates.slice(0, MAX_CANDIDATES_PER_FILE);
    } catch {
      // A failed Pass-1 call for one file must not abort the whole scan - skip this file only.
      continue;
    }

    for (const candidate of candidates) {
      if (!isLineRangeValid(file.content, candidate.lineStart, candidate.lineEnd)) continue;

      const contextFiles = gatherContextFiles(file.relativePath, file.content, params.loadFile);

      let confirmation;
      try {
        const res = await reviewConfirmation({
          projectId: params.projectId,
          candidate,
          fileRelativePath: file.relativePath,
          fileContent: file.content,
          contextFiles,
        });
        confirmation = res.result;
      } catch {
        // A failed Pass-2 call means this candidate can't be confirmed - discard it, don't
        // fall back to trusting the unconfirmed Pass-1 candidate.
        continue;
      }

      if (confirmation.verdict === "discard") continue;
      if (confirmation.confidence < MIN_PERSIST_CONFIDENCE) continue;

      confirmed.push({
        title: candidate.title,
        severity: candidate.severity,
        vulnerabilityClass: candidate.vulnerabilityClass,
        location: `${file.relativePath}:${candidate.lineStart}`,
        description: candidate.description,
        suggestion: candidate.suggestion,
        confidence: confirmation.confidence,
      });
    }
  }

  return confirmed;
}
