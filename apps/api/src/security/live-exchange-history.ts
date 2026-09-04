import { prisma } from "../prisma.js";
import { loadPersistedExchange, readBodyFile } from "../runner/live-security-persist.js";
import { clientExchange } from "./live-exchange-serialize.js";
import type { SecurityHttpExchange } from "./http-exchange.js";

// Ticket 0.5 — UI history recovery. Pagination/query logic for the two REST routes
// (GET .../exchanges, GET .../experiments) factored out here, HTTP-agnostic, so it's directly
// testable without a Fastify+Clerk auth harness (no precedent for that exists in this repo —
// routes/security.ts's handlers stay thin wrappers: auth + ownership check, then delegate).
// Both list functions cap and default `limit` themselves — callers don't need to.

export type ExchangeHistoryPage = {
  exchanges: SecurityHttpExchange[];
  nextCursor: string | null;
  totalCount: number;
};

export async function listExchangeHistory(
  authSessionId: string,
  opts: { limit?: number; before?: string }
): Promise<ExchangeHistoryPage> {
  const limit = Math.min(500, Math.max(1, opts.limit ?? 200));
  const where: { authSessionId: string; seq?: { lt: bigint } } = { authSessionId };
  if (opts.before !== undefined) {
    where.seq = { lt: BigInt(opts.before) }; // throws on a malformed cursor — caller's job to catch/validate before calling
  }

  const [rows, totalCount] = await Promise.all([
    prisma.securityLiveExchange.findMany({
      where,
      orderBy: { seq: "desc" },
      take: limit,
      select: { id: true, seq: true },
    }),
    prisma.securityLiveExchange.count({ where: { authSessionId } }),
  ]);

  const exchanges: SecurityHttpExchange[] = [];
  for (const row of rows) {
    const full = await loadPersistedExchange(authSessionId, row.id);
    if (full) exchanges.push(clientExchange(full));
  }
  exchanges.reverse(); // oldest-first — matches the order WS-appended "exchange" messages arrive in

  // seq is a Prisma BigInt: JSON.stringify throws on a raw BigInt, so nextCursor is always a
  // string, never the bigint itself.
  const nextCursor = rows.length === limit ? rows[rows.length - 1].seq.toString() : null;
  return { exchanges, nextCursor, totalCount };
}

export type ExperimentHistoryItem = {
  id: string;
  authSessionId: string;
  baselineExchangeId: string | null;
  baselineUrl: string;
  baselineMethod: string;
  kind: string;
  requestJson: unknown;
  resultStatus: number | null;
  resultBody: string | null;
  diffJson: unknown;
  securityTestResultJson: unknown;
  error: string | null;
  createdAt: string;
};

export type ExperimentHistoryPage = {
  experiments: ExperimentHistoryItem[];
  nextCursor: string | null;
};

export async function listExperimentHistory(
  authSessionId: string,
  opts: { limit?: number; before?: string }
): Promise<ExperimentHistoryPage> {
  const limit = Math.min(200, Math.max(1, opts.limit ?? 50));
  const where: { authSessionId: string; createdAt?: { lt: Date } } = { authSessionId };
  if (opts.before !== undefined) {
    const cursorDate = new Date(opts.before);
    if (Number.isNaN(cursorDate.getTime())) throw new Error("Invalid before cursor");
    where.createdAt = { lt: cursorDate };
  }

  const rows = await prisma.securityLiveExperiment.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: limit,
  });

  // resultBody/diffJson/securityTestResultJson are returned exactly as unredacted as the WS
  // path already broadcasts mutatedResult/diff today (only the baseline exchange gets
  // clientExchange() redaction there) — matching, not weakening, existing exposure.
  const experiments: ExperimentHistoryItem[] = [];
  for (const row of rows) {
    let resultBody = row.resultBodyInline;
    if (resultBody === null && row.resultBodyPath) {
      resultBody = await readBodyFile(row.resultBodyPath);
    }
    experiments.push({
      id: row.id,
      authSessionId: row.authSessionId,
      baselineExchangeId: row.baselineExchangeId,
      baselineUrl: row.baselineUrl,
      baselineMethod: row.baselineMethod,
      kind: row.kind,
      requestJson: row.requestJson,
      resultStatus: row.resultStatus,
      resultBody,
      diffJson: row.diffJson,
      securityTestResultJson: row.securityTestResultJson,
      error: row.error,
      createdAt: row.createdAt.toISOString(),
    });
  }
  experiments.reverse();

  const nextCursor = rows.length === limit ? rows[rows.length - 1].createdAt.toISOString() : null;
  return { experiments, nextCursor };
}
