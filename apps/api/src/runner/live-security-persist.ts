import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { prisma } from "../prisma.js";
import { LIVE_SECURITY_ROOT } from "../lib/storageRoots.js";
import { ensureWithin } from "../testmind/curated-store.js";
import type { SecurityHttpExchange } from "../security/http-exchange.js";

// Durable exchange writer (TestMind Autonomous v1, Phase 0, Ticket 0.2) — dual-writes every
// captured exchange to Postgres/disk alongside the existing in-memory buffer. Content at or
// below INLINE_BODY_MAX_CHARS is stored inline in Postgres (cheap, avoids a filesystem
// round-trip for the common small-JSON-response case); larger content (which, given the
// existing MAX_CAPTURED_BODY_CHARS/MAX_CAPTURED_POST_DATA_CHARS capture ceilings, means
// everything already truncated by capture) is written to disk under LIVE_SECURITY_ROOT and
// only a path is stored in the row.
//
// Ticket 0.4 adds a small hand-rolled bounded-concurrency queue in front of persistExchange
// (no p-limit-style dependency exists in this repo) so CDP event handlers stay fast — they
// enqueue and return immediately rather than awaiting the DB/disk write inline. getPersistQueueDepth()
// exposes outstanding work (queued + in-flight) so live-security-session.ts can apply
// high/low watermark backpressure at capture time.

const INLINE_BODY_MAX_CHARS = 8_000;
const PERSIST_QUEUE_CONCURRENCY = 4;
export const PERSIST_QUEUE_HIGH_WATERMARK = 1_000;
export const PERSIST_QUEUE_LOW_WATERMARK = 500;

async function writeBodyFile(relDir: string, filename: string, content: string): Promise<string> {
  const dir = path.join(LIVE_SECURITY_ROOT, relDir);
  const dest = path.join(dir, filename);
  ensureWithin(LIVE_SECURITY_ROOT, dest);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(dest, content, "utf8");
  return dest;
}

export async function persistExchange(exchange: SecurityHttpExchange): Promise<void> {
  const authSessionId = exchange.sessionId;

  const exchangeDir = path.join(authSessionId, exchange.id);
  let requestPostDataInline: string | null = null;
  let requestPostDataPath: string | null = null;
  if (exchange.request.postData) {
    if (exchange.request.postData.length <= INLINE_BODY_MAX_CHARS) {
      requestPostDataInline = exchange.request.postData;
    } else {
      requestPostDataPath = await writeBodyFile(exchangeDir, "request.postdata", exchange.request.postData);
    }
  }

  let responseBodyInline: string | null = null;
  let responseBodyPath: string | null = null;
  let responseBodyBytes: number | null = null;
  if (exchange.response?.body !== undefined) {
    responseBodyBytes = exchange.response.body.length;
    if (exchange.response.body.length <= INLINE_BODY_MAX_CHARS) {
      responseBodyInline = exchange.response.body;
    } else {
      responseBodyPath = await writeBodyFile(exchangeDir, "response.body", exchange.response.body);
    }
  }

  await prisma.securityLiveExchange.upsert({
    where: { id: exchange.id },
    create: {
      id: exchange.id,
      authSessionId,
      timestamp: new Date(exchange.timestamp),
      method: exchange.request.method,
      url: exchange.request.url,
      requestHeadersJson: exchange.request.headers,
      requestPostDataInline,
      requestPostDataPath,
      responseStatus: exchange.response?.status ?? null,
      responseHeadersJson: exchange.response?.headers ?? undefined,
      responseDurationMs: exchange.response?.durationMs ?? null,
      responseBodyInline,
      responseBodyPath,
      responseBodyBytes,
      correlatedActionId: exchange.correlatedActionId ?? null,
    },
    // Idempotent no-op update: pushExchange() only ever calls persist once per exchange id in
    // practice, but upsert (rather than create) means a retry can never throw a unique-
    // constraint error and take down the capture path.
    update: {},
  });
}

// Ticket 0.5 — persist mutation/replay/securityTest results, mirroring persistExchange's
// inline-vs-disk threshold. Experiments have no client-supplied id (unlike exchanges, whose
// id is generated at capture time and shared with the client for later lookup), so one is
// generated here up front — needed before the DB write to build the disk path.
export type ExperimentPersistInput = {
  authSessionId: string;
  baselineExchangeId?: string;
  baselineUrl: string;
  baselineMethod: string;
  kind: "mutation" | "replay" | "securityTest";
  requestJson?: unknown;
  resultStatus?: number;
  resultBody?: string;
  diffJson?: unknown;
  securityTestResultJson?: unknown;
  error?: string;
};

export async function persistExperiment(input: ExperimentPersistInput): Promise<void> {
  const experimentId = crypto.randomUUID();

  let resultBodyInline: string | null = null;
  let resultBodyPath: string | null = null;
  if (input.resultBody !== undefined) {
    if (input.resultBody.length <= INLINE_BODY_MAX_CHARS) {
      resultBodyInline = input.resultBody;
    } else {
      resultBodyPath = await writeBodyFile(
        path.join(input.authSessionId, "experiments", experimentId),
        "result.body",
        input.resultBody
      );
    }
  }

  await prisma.securityLiveExperiment.create({
    data: {
      id: experimentId,
      authSessionId: input.authSessionId,
      baselineExchangeId: input.baselineExchangeId ?? null,
      baselineUrl: input.baselineUrl,
      baselineMethod: input.baselineMethod,
      kind: input.kind,
      requestJson: input.requestJson === undefined ? undefined : (input.requestJson as any),
      resultStatus: input.resultStatus ?? null,
      resultBodyInline,
      resultBodyPath,
      diffJson: input.diffJson === undefined ? undefined : (input.diffJson as any),
      securityTestResultJson: input.securityTestResultJson === undefined ? undefined : (input.securityTestResultJson as any),
      error: input.error ?? null,
    },
  });
}

// Bounded-concurrency dispatcher shared by exchange and experiment persistence — queueDepth
// counts everything not yet finished (queued + in-flight), which is the right notion of
// "backlog" for watermark purposes regardless of which kind of write it is.
let queueDepth = 0;
let activeCount = 0;
const pending: Array<() => Promise<void>> = [];

function pump() {
  while (activeCount < PERSIST_QUEUE_CONCURRENCY && pending.length > 0) {
    const job = pending.shift()!;
    activeCount += 1;
    job().finally(() => {
      activeCount -= 1;
      queueDepth -= 1;
      pump();
    });
  }
}

function enqueueJob(job: () => Promise<void>): void {
  queueDepth += 1;
  pending.push(job);
  pump();
}

export function getPersistQueueDepth(): number {
  return queueDepth;
}

// Test-only convenience: since Ticket 0.4, persistence is asynchronous/queued rather than
// awaited inline, so a test that persists something and then immediately asserts on the DB
// (or tears down FK-dependent rows) needs to know the queue has actually drained.
export async function waitForPersistQueueIdle(timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (getPersistQueueDepth() > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// Fire-and-forget entry point for the CDP capture path — persistence must never throw into
// (or block) the Network.loadingFinished handler. Errors are handed to the caller's logger;
// onPersisted (optional) fires after a successful write so the caller can shrink its
// in-memory copy of the exchange body once it's known to be durable (Ticket 0.4, §3).
export function enqueuePersistExchange(
  exchange: SecurityHttpExchange,
  onError: (err: unknown) => void,
  onPersisted?: () => void
): void {
  enqueueJob(() => persistExchange(exchange).then(onPersisted).catch(onError));
}

// Fire-and-forget entry point for handleMutateMessage/handleReplayMessage/
// handleSecurityTestMessage (Ticket 0.5) — persistence failure must not affect the existing
// live WS result path, which has already broadcast by the time this is called.
export function enqueuePersistExperiment(input: ExperimentPersistInput, onError: (err: unknown) => void): void {
  enqueueJob(() => persistExperiment(input).catch(onError));
}

// Durable exchange retrieval (Ticket 0.3) — the fallback path for handleMutateMessage /
// handleReplayMessage / handleSecurityTestMessage when an exchange has scrolled out of the
// in-memory buffer. Scoped to authSessionId in the query itself (not a separate check
// afterward) so an exchange id from another session can never be resolved here. Any failure
// to rehydrate a body from disk (missing/corrupt file) is treated as a full miss — returns
// null rather than a partially-reconstructed exchange, so callers fall through to the same
// "unknown exchange" error path already used for an outright buffer miss.
export async function readBodyFile(dest: string): Promise<string | null> {
  try {
    ensureWithin(LIVE_SECURITY_ROOT, dest);
    return await fs.readFile(dest, "utf8");
  } catch {
    return null;
  }
}

export async function loadPersistedExchange(authSessionId: string, exchangeId: string): Promise<SecurityHttpExchange | null> {
  const row = await prisma.securityLiveExchange.findFirst({ where: { id: exchangeId, authSessionId } });
  if (!row) return null;

  let requestPostData: string | undefined;
  if (row.requestPostDataInline !== null) {
    requestPostData = row.requestPostDataInline;
  } else if (row.requestPostDataPath) {
    const content = await readBodyFile(row.requestPostDataPath);
    if (content === null) return null;
    requestPostData = content;
  }

  let responseBody: string | undefined;
  if (row.responseBodyInline !== null) {
    responseBody = row.responseBodyInline;
  } else if (row.responseBodyPath) {
    const content = await readBodyFile(row.responseBodyPath);
    if (content === null) return null;
    responseBody = content;
  }

  return {
    id: row.id,
    sessionId: row.authSessionId,
    timestamp: row.timestamp.getTime(),
    request: {
      method: row.method,
      url: row.url,
      headers: (row.requestHeadersJson as Record<string, string>) ?? {},
      postData: requestPostData,
    },
    response:
      row.responseStatus !== null
        ? {
            status: row.responseStatus,
            headers: (row.responseHeadersJson as Record<string, string>) ?? {},
            body: responseBody,
            durationMs: row.responseDurationMs ?? 0,
          }
        : undefined,
    correlatedActionId: row.correlatedActionId ?? undefined,
  };
}
