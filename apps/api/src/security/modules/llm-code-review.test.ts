import test from "node:test";
import assert from "node:assert/strict";
import {
  selectFilesForReview,
  isLineRangeValid,
  reviewRepoForVulnerabilities,
  MAX_REVIEW_FILES,
  MAX_REVIEW_BYTES,
  MIN_PERSIST_CONFIDENCE,
  type FileEntry,
  type LoadedFile,
} from "./llm-code-review.js";

// Target Repo Security Review v1, Pass 1 (TRS.1 file selection + TRS.2 two-pass orchestration).
// No DB, no real LLM - reviewRepoForVulnerabilities's LLM calls are injected stubs here,
// matching the same deterministic-boundary discipline TRS.4's real pipeline certification
// (a separate, later ticket) will also require.

test("selectFilesForReview: only route/controller/api/middleware/auth-shaped paths are selected", () => {
  const files: FileEntry[] = [
    { relativePath: "src/routes/orders.ts", size: 100 },
    { relativePath: "src/controllers/UserController.ts", size: 100 },
    { relativePath: "src/api/handlers.ts", size: 100 },
    { relativePath: "src/middleware/auth.ts", size: 100 },
    { relativePath: "src/authService.ts", size: 100 },
    { relativePath: "src/utils/format.ts", size: 100 },
    { relativePath: "README.md", size: 100 },
  ];
  const selected = selectFilesForReview(files).map((f) => f.relativePath);
  assert.deepEqual(selected, [
    "src/api/handlers.ts",
    "src/authService.ts",
    "src/controllers/UserController.ts",
    "src/middleware/auth.ts",
    "src/routes/orders.ts",
  ]);
});

test("selectFilesForReview: caps at MAX_REVIEW_FILES", () => {
  const files: FileEntry[] = Array.from({ length: MAX_REVIEW_FILES + 10 }, (_, i) => ({
    relativePath: `src/routes/route-${String(i).padStart(3, "0")}.ts`,
    size: 10,
  }));
  const selected = selectFilesForReview(files);
  assert.equal(selected.length, MAX_REVIEW_FILES);
});

test("selectFilesForReview: caps at MAX_REVIEW_BYTES, skipping files that would exceed the budget rather than truncating file count alone", () => {
  const files: FileEntry[] = [
    { relativePath: "src/routes/a.ts", size: MAX_REVIEW_BYTES - 10 },
    { relativePath: "src/routes/b.ts", size: 20 },
    { relativePath: "src/routes/c.ts", size: 5 },
  ];
  const selected = selectFilesForReview(files).map((f) => f.relativePath);
  // "a" consumes almost the whole budget; "b" (20 bytes) would exceed it and is skipped;
  // "c" (5 bytes) still fits.
  assert.deepEqual(selected, ["src/routes/a.ts", "src/routes/c.ts"]);
});

test("isLineRangeValid: rejects zero/negative start, end before start, and out-of-range lines", () => {
  const content = "line1\nline2\nline3";
  assert.equal(isLineRangeValid(content, 1, 1), true);
  assert.equal(isLineRangeValid(content, 2, 3), true);
  assert.equal(isLineRangeValid(content, 0, 1), false);
  assert.equal(isLineRangeValid(content, 2, 1), false);
  assert.equal(isLineRangeValid(content, 10, 10), false, "line 10 doesn't exist in a 3-line file");
});

function stubFiles(entries: Record<string, string>): { listFiles: () => FileEntry[]; loadFile: (p: string) => LoadedFile | null } {
  return {
    listFiles: () => Object.entries(entries).map(([relativePath, content]) => ({ relativePath, size: content.length })),
    loadFile: (relativePath: string) => (relativePath in entries ? { relativePath, content: entries[relativePath] } : null),
  };
}

test("reviewRepoForVulnerabilities: a confirmed, sufficiently-confident, in-range candidate becomes a ConfirmedFinding", async () => {
  const { listFiles, loadFile } = stubFiles({ "src/routes/orders.ts": "line1\napp.get('/orders/:id', handler)\nline3" });

  const result = await reviewRepoForVulnerabilities({
    listFiles,
    loadFile,
    reviewCandidates: async () => ({
      candidates: [
        {
          title: "Missing ownership check",
          severity: "high",
          vulnerabilityClass: "missing_authorization",
          lineStart: 2,
          lineEnd: 2,
          description: "No ownership check before returning the order.",
          suggestion: "Verify order.ownerId matches the caller.",
          confidence: 0.7,
        },
      ],
      raw: "{}",
    }),
    reviewConfirmation: async () => ({ result: { verdict: "confirm", confidence: 0.9, rationale: "no ownership check anywhere in scope" }, raw: "{}" }),
  });

  assert.equal(result.length, 1);
  assert.equal(result[0].location, "src/routes/orders.ts:2");
  assert.equal(result[0].confidence, 0.9, "the finding's persisted confidence is Pass 2's revised confidence, not Pass 1's");
});

test("reviewRepoForVulnerabilities: a discarded candidate is never persisted", async () => {
  const { listFiles, loadFile } = stubFiles({ "src/routes/orders.ts": "line1\nline2\nline3" });

  const result = await reviewRepoForVulnerabilities({
    listFiles,
    loadFile,
    reviewCandidates: async () => ({
      candidates: [
        { title: "x", severity: "high", vulnerabilityClass: "x", lineStart: 2, lineEnd: 2, description: "d", suggestion: "s", confidence: 0.9 },
      ],
      raw: "{}",
    }),
    reviewConfirmation: async () => ({
      result: { verdict: "discard", confidence: 0.1, rationale: "the ownership check happens in the imported service layer" },
      raw: "{}",
    }),
  });

  assert.deepEqual(result, []);
});

test("reviewRepoForVulnerabilities: a confirmed candidate below MIN_PERSIST_CONFIDENCE is never persisted", async () => {
  const { listFiles, loadFile } = stubFiles({ "src/routes/orders.ts": "line1\nline2\nline3" });

  const result = await reviewRepoForVulnerabilities({
    listFiles,
    loadFile,
    reviewCandidates: async () => ({
      candidates: [
        { title: "x", severity: "medium", vulnerabilityClass: "x", lineStart: 2, lineEnd: 2, description: "d", suggestion: "s", confidence: 0.9 },
      ],
      raw: "{}",
    }),
    reviewConfirmation: async () => ({
      result: { verdict: "confirm", confidence: MIN_PERSIST_CONFIDENCE - 0.01, rationale: "plausible but not certain" },
      raw: "{}",
    }),
  });

  assert.deepEqual(result, [], "confirmed is not enough on its own - confidence must also clear MIN_PERSIST_CONFIDENCE");
});

test("reviewRepoForVulnerabilities: an out-of-range candidate never reaches Pass 2 at all", async () => {
  const { listFiles, loadFile } = stubFiles({ "src/routes/orders.ts": "line1\nline2\nline3" });
  let pass2Called = false;

  const result = await reviewRepoForVulnerabilities({
    listFiles,
    loadFile,
    reviewCandidates: async () => ({
      candidates: [
        { title: "x", severity: "high", vulnerabilityClass: "x", lineStart: 99, lineEnd: 99, description: "d", suggestion: "s", confidence: 0.9 },
      ],
      raw: "{}",
    }),
    reviewConfirmation: async () => {
      pass2Called = true;
      return { result: { verdict: "confirm", confidence: 0.9, rationale: "n/a" }, raw: "{}" };
    },
  });

  assert.deepEqual(result, []);
  assert.equal(pass2Called, false, "an out-of-range candidate must be dropped before spending a second LLM call on it");
});

test("reviewRepoForVulnerabilities: a Pass 1 failure for one file skips that file without aborting the scan", async () => {
  const { listFiles, loadFile } = stubFiles({
    "src/routes/broken.ts": "content",
    "src/routes/ok.ts": "line1\nline2",
  });

  const result = await reviewRepoForVulnerabilities({
    listFiles,
    loadFile,
    reviewCandidates: async ({ relativePath }) => {
      if (relativePath === "src/routes/broken.ts") throw new Error("LLM call failed");
      return {
        candidates: [
          { title: "ok finding", severity: "low", vulnerabilityClass: "x", lineStart: 1, lineEnd: 1, description: "d", suggestion: "s", confidence: 0.9 },
        ],
        raw: "{}",
      };
    },
    reviewConfirmation: async () => ({ result: { verdict: "confirm", confidence: 0.9, rationale: "n/a" }, raw: "{}" }),
  });

  assert.equal(result.length, 1);
  assert.equal(result[0].location, "src/routes/ok.ts:1");
});
