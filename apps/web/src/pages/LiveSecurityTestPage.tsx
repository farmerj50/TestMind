import { useEffect, useRef, useState } from "react";
import { useSearchParams, Link } from "react-router-dom";
import { useApi, apiUrl } from "../lib/api";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { LiveBrowserView } from "../components/security/LiveBrowserView";

// Live Security Testing v0.1 (POC). A person drives a real, already-authenticated browser
// session; every captured HTTP request that looks like it carries a resource ID gets a
// "Test this ID" control. Triggering it clones that exact captured request, swaps the one
// server-detected candidate, replays it, and shows the raw diff — no AI, no autonomous
// mutation, no verdict. See the plan for the four invariants this UI can never bypass:
// the server only ever mutates a candidate IT detected on a request IT captured.

const VIEWPORT = { width: 1280, height: 800 };

type ResourceIdCandidate = { location: "path" | "query"; paramName: string; value: string };

type SecurityHttpExchange = {
  id: string;
  sessionId: string;
  timestamp: number;
  request: { method: string; url: string; headers: Record<string, string>; postData?: string };
  response?: { status: number; headers: Record<string, string>; body?: string; durationMs: number };
  correlatedActionId?: string;
};

type ExchangeDiff = {
  statusMatch: boolean;
  baselineStatus?: number;
  mutatedStatus?: number;
  bodyLengthDelta: number;
  addedKeys: string[];
  removedKeys: string[];
  changedKeys: string[];
};

type ExperimentState =
  | { status: "idle" }
  | { status: "running" }
  | { status: "done"; mutatedStatus?: number; mutatedBody?: string; diff: ExchangeDiff }
  | { status: "error"; error: string };

// Same shape http-exchange.ts's detectResourceIdCandidates produces — kept in sync manually
// since the frontend can't import the backend module directly. Any drift here only affects
// which candidates the UI *offers*; the server independently re-validates every mutation
// against its own detection, so a stale/wrong client-side copy can never widen what's
// actually allowed to execute.
function detectResourceIdCandidates(url: string): ResourceIdCandidate[] {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return [];
  }
  const looksLikeId = (v: string) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v) ||
    /^c[a-z0-9]{24,}$/i.test(v) ||
    /^\d{2,}$/.test(v);
  const candidates: ResourceIdCandidate[] = [];
  parsed.pathname
    .split("/")
    .filter(Boolean)
    .forEach((segment, index) => {
      if (looksLikeId(segment)) candidates.push({ location: "path", paramName: `segment${index}`, value: segment });
    });
  for (const [key, value] of parsed.searchParams.entries()) {
    if (looksLikeId(value)) candidates.push({ location: "query", paramName: key, value });
  }
  return candidates;
}

export default function LiveSecurityTestPage() {
  const { apiFetch } = useApi();
  const [searchParams] = useSearchParams();
  const authSessionId = searchParams.get("authSessionId") ?? "";

  const [connecting, setConnecting] = useState(false);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exchanges, setExchanges] = useState<SecurityHttpExchange[]>([]);
  const [experiments, setExperiments] = useState<Record<string, ExperimentState>>({});
  const [mutationInputs, setMutationInputs] = useState<Record<string, string>>({});

  const wsRef = useRef<WebSocket | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);

  function sendInput(payload: Record<string, unknown>) {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
  }

  function stopSession() {
    sendInput({ type: "stop" });
    wsRef.current?.close();
    wsRef.current = null;
    setConnected(false);
  }

  useEffect(() => {
    if (!authSessionId) return;
    let cancelled = false;

    async function connect() {
      setConnecting(true);
      setError(null);
      try {
        const res = await apiFetch<{ ticket: string }>(`/security/auth-sessions/${authSessionId}/live-test-ticket`, {
          method: "POST",
        });
        if (cancelled) return;
        const httpBase = apiUrl(`/security/auth-sessions/${authSessionId}/live-test`);
        const wsUrl = `${httpBase.replace(/^http/, "ws")}?ticket=${encodeURIComponent(res.ticket)}`;
        const ws = new WebSocket(wsUrl);
        wsRef.current = ws;

        ws.onopen = () => {
          setConnected(true);
          setConnecting(false);
        };
        ws.onmessage = (evt) => {
          let msg: any;
          try {
            msg = JSON.parse(evt.data);
          } catch {
            return;
          }
          if (msg.type === "frame" && imgRef.current) {
            imgRef.current.src = `data:image/jpeg;base64,${msg.data}`;
          } else if (msg.type === "exchange") {
            setExchanges((prev) => (prev.some((e) => e.id === msg.exchange.id) ? prev : [...prev, msg.exchange]));
          } else if (msg.type === "experimentResult") {
            setExperiments((prev) => ({
              ...prev,
              [msg.exchangeId]: {
                status: "done",
                mutatedStatus: msg.mutatedResult?.status,
                mutatedBody: msg.mutatedResult?.body,
                diff: msg.diff,
              },
            }));
          } else if (msg.type === "experimentError") {
            setExperiments((prev) => ({ ...prev, [msg.exchangeId]: { status: "error", error: msg.error } }));
          } else if (msg.type === "status" && msg.status === "failed") {
            setError(msg.error ?? "Live session failed");
          }
        };
        ws.onerror = () => {
          setError("Live session disconnected.");
          setConnected(false);
        };
        ws.onclose = () => {
          if (wsRef.current === ws) wsRef.current = null;
          setConnected(false);
          setConnecting(false);
        };
      } catch (err: any) {
        if (!cancelled) {
          setError(err?.message ?? "Failed to start live testing session");
          setConnecting(false);
        }
      }
    }

    connect();
    return () => {
      cancelled = true;
      wsRef.current?.close();
      wsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authSessionId]);

  function runExperiment(exchange: SecurityHttpExchange, candidate: ResourceIdCandidate) {
    const key = `${exchange.id}:${candidate.location}:${candidate.paramName}`;
    const newValue = mutationInputs[key]?.trim();
    if (!newValue) return;
    setExperiments((prev) => ({ ...prev, [exchange.id]: { status: "running" } }));
    sendInput({
      type: "mutate",
      exchangeId: exchange.id,
      location: candidate.location,
      paramName: candidate.paramName,
      newValue,
    });
  }

  if (!authSessionId) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-10">
        <p className="text-sm text-slate-600">
          No auth session specified.{" "}
          <Link to="/security-scan" className="text-emerald-600 underline">
            Go back to Security Scan
          </Link>{" "}
          and start a Live Test from a captured Bug Bounty session.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-7xl px-4 py-6">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Live Security Test</h1>
          <p className="text-sm text-slate-600">
            {connecting ? "Connecting..." : connected ? "Connected — browse the app normally." : "Disconnected"}
          </p>
        </div>
        <Button type="button" variant="outline" onClick={stopSession} disabled={!connected}>
          Stop session
        </Button>
      </div>

      {error && <div className="mb-4 rounded border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div>}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Browser</CardTitle>
          </CardHeader>
          <CardContent>
            <LiveBrowserView viewport={VIEWPORT} imgRef={imgRef} sendInput={sendInput} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Captured traffic ({exchanges.length})</CardTitle>
          </CardHeader>
          <CardContent className="max-h-[600px] space-y-2 overflow-y-auto">
            {exchanges.length === 0 && <p className="text-sm text-slate-500">No requests captured yet — browse the app.</p>}
            {exchanges.map((exchange) => {
              const candidates = detectResourceIdCandidates(exchange.request.url);
              const isGet = exchange.request.method.toUpperCase() === "GET";
              const experiment = experiments[exchange.id];
              return (
                <div key={exchange.id} className="rounded border border-slate-200 p-2 text-xs">
                  <div className="flex items-center gap-2">
                    <span className="font-mono font-semibold">{exchange.request.method}</span>
                    <span className="truncate text-slate-700">{exchange.request.url}</span>
                    <span
                      className={
                        exchange.response && exchange.response.status < 400 ? "ml-auto text-emerald-600" : "ml-auto text-rose-600"
                      }
                    >
                      {exchange.response?.status ?? "…"}
                    </span>
                  </div>
                  {exchange.correlatedActionId && <div className="mt-1 text-slate-400">triggered by user input</div>}

                  {isGet &&
                    candidates.map((candidate) => {
                      const key = `${exchange.id}:${candidate.location}:${candidate.paramName}`;
                      return (
                        <div key={key} className="mt-2 flex items-center gap-2 border-t border-dashed border-slate-200 pt-2">
                          <span className="text-slate-500">
                            {candidate.location} <code>{candidate.paramName}</code> = <code>{candidate.value}</code>
                          </span>
                          <input
                            className="w-24 rounded border border-slate-300 px-1 py-0.5 text-xs"
                            placeholder="new value"
                            value={mutationInputs[key] ?? ""}
                            onChange={(e) => setMutationInputs((prev) => ({ ...prev, [key]: e.target.value }))}
                          />
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={!mutationInputs[key]?.trim() || experiment?.status === "running"}
                            onClick={() => runExperiment(exchange, candidate)}
                          >
                            {experiment?.status === "running" ? "Testing..." : "Test this ID"}
                          </Button>
                        </div>
                      );
                    })}

                  {experiment?.status === "done" && (
                    <div className="mt-2 rounded bg-slate-50 p-2">
                      <div>
                        Baseline {exchange.response?.status} → Mutated {experiment.mutatedStatus}
                        {experiment.diff.statusMatch ? " (same status)" : " (status changed)"}
                      </div>
                      <div>Body length delta: {experiment.diff.bodyLengthDelta}</div>
                      {experiment.diff.changedKeys.length > 0 && <div>Changed keys: {experiment.diff.changedKeys.join(", ")}</div>}
                      {experiment.diff.addedKeys.length > 0 && <div>Added keys: {experiment.diff.addedKeys.join(", ")}</div>}
                      {experiment.diff.removedKeys.length > 0 && <div>Removed keys: {experiment.diff.removedKeys.join(", ")}</div>}
                    </div>
                  )}
                  {experiment?.status === "error" && (
                    <div className="mt-2 rounded bg-rose-50 p-2 text-rose-700">{experiment.error}</div>
                  )}
                </div>
              );
            })}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
