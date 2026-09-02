import { useEffect, useState } from "react";
import { useApi } from "../lib/api";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";

// ── Types ─────────────────────────────────────────────────────────────────────

type SavedProgram = {
  id: string; name: string; programRules: string;
  targetUrl: string; featureOrFlow: string; notes?: string;
  updatedAt: string;
};

type AuthType = "none" | "bearer" | "cookie" | "basic";

type VerificationStep = { step: number; action: string; expectedResult: string; tool: string };
type RiskArea = {
  area: string; actualFinding: string; whyItMatters: string;
  severity: Sev; reportability: Sev;
  manualVerificationSteps: VerificationStep[];
};
type ReportDraft = { title: string; impact: string; stepsToReproduce: string[]; evidenceNeeded: string[] };
type Sev = "info" | "low" | "medium" | "high";

type JwtFinding  = { issue: string; severity: Sev };
type JwtAnalysis = { header: Record<string, unknown>; payload: Record<string, unknown>; findings: JwtFinding[]; expiresAt: string | null; algorithm: string | null };
type GenFinding  = { issue: string; severity: Sev; header?: string; path?: string; cookie?: string; value?: string | null; status?: number; requestOrigin?: string; allowOrigin?: string | null; allowCredentials?: string | null };
type AccessFinding = { url: string; unauthStatus: number; authStatus: number | null; issue: string; severity: Sev };
type IdorFinding   = { originalUrl: string; testUrl: string; originalId: string; testId: string; originalStatus: number; testStatus: number; issue: string; severity: Sev };

type ProbeResults = {
  targetUrl: string; finalUrl: string; responseStatus: number;
  serverInfo: Record<string, string>;
  headerFindings: GenFinding[]; corsFindings: GenFinding[];
  pathFindings: GenFinding[]; cookieFindings: GenFinding[];
  accessFindings: AccessFinding[]; idorFindings: IdorFinding[];
  jwtAnalysis: JwtAnalysis | null;
};

type AnalysisResult = {
  scopeStatus: "in_scope" | "out_of_scope" | "unclear";
  summary: string; riskAreas: RiskArea[]; reportDraft: ReportDraft; probe: ProbeResults;
};

// ── Styles ────────────────────────────────────────────────────────────────────

const SEV: Record<string, string> = {
  high:   "bg-red-100 text-red-700 border-red-200",
  medium: "bg-yellow-100 text-yellow-700 border-yellow-200",
  low:    "bg-blue-100 text-blue-700 border-blue-200",
  info:   "bg-gray-100 text-gray-500 border-gray-200",
};
const SCOPE_CLS: Record<string, string> = {
  in_scope: "bg-green-100 text-green-700", out_of_scope: "bg-red-100 text-red-700", unclear: "bg-yellow-100 text-yellow-700",
};

function Badge({ sev, label }: { sev: string; label?: string }) {
  return <span className={`text-[10px] font-semibold uppercase px-2 py-0.5 rounded border ${SEV[sev] ?? SEV.info}`}>{label ?? sev}</span>;
}

function FindingRow({ f }: { f: GenFinding }) {
  const label = f.header ?? f.path ?? f.cookie ?? "—";
  return (
    <div className="flex items-start gap-3 py-2 border-t first:border-t-0">
      <Badge sev={f.severity} />
      <div className="flex-1 min-w-0">
        <p className="text-xs font-mono text-muted-foreground truncate">{label}</p>
        <p className="text-sm">{f.issue}</p>
        {f.value && <p className="text-xs font-mono text-muted-foreground truncate mt-0.5">{f.value}</p>}
        {f.allowOrigin && <p className="text-xs font-mono text-muted-foreground mt-0.5">ACAO: {f.allowOrigin}{f.allowCredentials ? ` | ACAC: ${f.allowCredentials}` : ""}</p>}
      </div>
    </div>
  );
}

function Section({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  if (count === 0) return null;
  return (
    <div>
      <p className="text-xs font-semibold uppercase text-muted-foreground mb-2">{title} ({count})</p>
      {children}
    </div>
  );
}

// ── Auth Test Types ───────────────────────────────────────────────────────────

type AccountAuthType = "bearer" | "cookie" | "basic";
type AuthTestEvidence = { url: string; authPresent: boolean; status: number; bodyLength: number; bodySnippet: string };
type AuthTestFinding = { issue: string; severity: Sev; confidence: "low" | "medium" | "high"; evidenceA: AuthTestEvidence; evidenceB?: AuthTestEvidence };
type AuthTestResult = { testName: string; description: string; skipped: boolean; skippedReason?: string; finding?: AuthTestFinding };
type AuthFinding = { testName: string; category?: string; issue: string; severity: Sev; confidence: "low" | "medium" | "high"; confidenceReason?: string };
type AuthAnalysis = { tests: AuthTestResult[]; summary: string; findings: AuthFinding[]; reportDraft: { title: string; impact: string; stepsToReproduce: string[]; evidenceNeeded: string[] } };

function AccountCard({
  label, secondary = false,
  authType, setAuthType,
  token, setToken,
  cookieName, setCookieName, cookieValue, setCookieValue,
  username, setUsername, password, setPassword,
  ownedResourceId, setOwnedResourceId,
}: {
  label: string; secondary?: boolean;
  authType: AccountAuthType; setAuthType: (v: AccountAuthType) => void;
  token: string; setToken: (v: string) => void;
  cookieName: string; setCookieName: (v: string) => void;
  cookieValue: string; setCookieValue: (v: string) => void;
  username: string; setUsername: (v: string) => void;
  password: string; setPassword: (v: string) => void;
  ownedResourceId: string; setOwnedResourceId: (v: string) => void;
}) {
  return (
    <div className={`rounded-md border p-4 space-y-3 ${secondary ? "border-dashed" : ""}`}>
      <p className="text-xs font-semibold uppercase text-muted-foreground">{label}</p>
      <Select value={authType} onValueChange={v => setAuthType(v as AccountAuthType)}>
        <SelectTrigger><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="bearer">Bearer token (JWT / API key)</SelectItem>
          <SelectItem value="cookie">Session cookie</SelectItem>
          <SelectItem value="basic">Basic auth</SelectItem>
        </SelectContent>
      </Select>
      {authType === "bearer" && <Input placeholder="Token (e.g. eyJhbGci…)" value={token} onChange={e => setToken(e.target.value)} />}
      {authType === "cookie" && (
        <div className="flex gap-2">
          <Input className="w-36" placeholder="Cookie name" value={cookieName} onChange={e => setCookieName(e.target.value)} />
          <Input className="flex-1" placeholder="Cookie value" value={cookieValue} onChange={e => setCookieValue(e.target.value)} />
        </div>
      )}
      {authType === "basic" && (
        <div className="flex gap-2">
          <Input placeholder="Username" value={username} onChange={e => setUsername(e.target.value)} />
          <Input type="password" placeholder="Password" value={password} onChange={e => setPassword(e.target.value)} />
        </div>
      )}
      <Input placeholder="Owned resource ID (e.g. 42 — for IDOR baseline)" value={ownedResourceId} onChange={e => setOwnedResourceId(e.target.value)} />
    </div>
  );
}

const CONF: Record<string, string> = {
  high: "bg-green-100 text-green-700",
  medium: "bg-yellow-100 text-yellow-700",
  low: "bg-gray-100 text-gray-500",
};

function AuthTestResultCard({ result }: { result: AuthTestResult }) {
  const { finding } = result;
  return (
    <div className={`rounded-md border p-4 space-y-2 ${result.skipped ? "opacity-50" : finding ? "border-red-200 bg-red-50/30 dark:bg-red-950/10" : "border-green-200 bg-green-50/30 dark:bg-green-950/10"}`}>
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-sm font-semibold">{result.testName}</span>
        {result.skipped && <span className="text-xs px-2 py-0.5 rounded bg-gray-100 text-gray-500">skipped</span>}
        {!result.skipped && !finding && <span className="text-xs px-2 py-0.5 rounded bg-green-100 text-green-700">clean</span>}
        {finding && <Badge sev={finding.severity} />}
        {finding && <span className={`text-xs px-2 py-0.5 rounded ${CONF[finding.confidence] ?? CONF.low}`}>confidence: {finding.confidence}</span>}
      </div>
      <p className="text-xs text-muted-foreground">{result.description}</p>
      {result.skippedReason && <p className="text-xs italic text-muted-foreground">{result.skippedReason}</p>}
      {finding && (
        <div className="space-y-2 mt-1">
          <p className="text-sm">{finding.issue}</p>
          <div className="rounded border overflow-hidden text-xs font-mono">
            <div className="grid grid-cols-4 gap-0 bg-muted/50 px-2 py-1 text-[10px] font-semibold uppercase text-muted-foreground">
              <span>Account</span><span>URL</span><span>Status</span><span>Body (bytes)</span>
            </div>
            {[finding.evidenceA, finding.evidenceB].filter(Boolean).map((ev, i) => ev && (
              <div key={i} className="grid grid-cols-4 gap-0 px-2 py-1 border-t">
                <span>{i === 0 ? (finding.evidenceB ? "A" : "A") : "B"} {ev.authPresent ? "🔑" : "🔓"}</span>
                <span className="truncate text-muted-foreground" title={ev.url}>{ev.url.replace(/^https?:\/\//, "").slice(0, 30)}</span>
                <span className={ev.status >= 200 && ev.status < 300 ? "text-green-600" : "text-red-500"}>{ev.status}</span>
                <span>{ev.bodyLength}</span>
              </div>
            ))}
          </div>
          {finding.evidenceA.bodySnippet && (
            <details className="text-xs">
              <summary className="cursor-pointer text-muted-foreground hover:text-foreground">View body snippets</summary>
              <div className="mt-1 space-y-1">
                <p className="text-muted-foreground font-semibold">Evidence A:</p>
                <pre className="p-2 bg-muted rounded overflow-x-auto">{finding.evidenceA.bodySnippet}</pre>
                {finding.evidenceB?.bodySnippet && (
                  <>
                    <p className="text-muted-foreground font-semibold">Evidence B:</p>
                    <pre className="p-2 bg-muted rounded overflow-x-auto">{finding.evidenceB.bodySnippet}</pre>
                  </>
                )}
              </div>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

function AuthTestSection({ targetUrl, programRules }: { targetUrl: string; programRules: string }) {
  const { apiFetch } = useApi();

  // Account A
  const [aAuthType, setAAuthType] = useState<AccountAuthType>("bearer");
  const [aToken,    setAToken]    = useState("");
  const [aCookieName, setACookieName] = useState("session");
  const [aCookieValue, setACookieValue] = useState("");
  const [aUsername, setAUsername] = useState("");
  const [aPassword, setAPassword] = useState("");
  const [aResourceId, setAResourceId] = useState("");

  // Account B
  const [showB, setShowB] = useState(false);
  const [bAuthType, setBAuthType] = useState<AccountAuthType>("bearer");
  const [bToken,    setBToken]    = useState("");
  const [bCookieName, setBCookieName] = useState("session");
  const [bCookieValue, setBCookieValue] = useState("");
  const [bUsername, setBUsername] = useState("");
  const [bPassword, setBPassword] = useState("");
  const [bResourceId, setBResourceId] = useState("");

  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState<string | null>(null);
  const [result,  setResult]  = useState<AuthAnalysis | null>(null);

  function buildAccount(
    authType: AccountAuthType, token: string,
    cookieName: string, cookieValue: string,
    username: string, password: string,
    ownedResourceId: string, label: string,
  ) {
    return { label, authType, token, cookieName, cookieValue, username, password, ownedResourceId: ownedResourceId || undefined };
  }

  async function runAuthTests() {
    if (!targetUrl) { setError("Set a target URL in the Program & Target section above first."); return; }
    setLoading(true); setError(null); setResult(null);
    try {
      const accountA = buildAccount(aAuthType, aToken, aCookieName, aCookieValue, aUsername, aPassword, aResourceId, "Account A");
      const accountB = showB ? buildAccount(bAuthType, bToken, bCookieName, bCookieValue, bUsername, bPassword, bResourceId, "Account B") : undefined;
      const data = await apiFetch<AuthAnalysis>("/research-agent/auth-test", {
        method: "POST",
        body: JSON.stringify({ programRules, targetUrl, accountA, accountB }),
      });
      setResult(data);
    } catch (err: any) {
      setError(err?.message ?? "Auth test failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Auth Test Suite</CardTitle>
        <p className="text-xs text-muted-foreground mt-0.5">
          Structured broken auth + IDOR tests using your owned test accounts. Credentials are never stored.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">

        <AccountCard
          label="Account A (required)"
          authType={aAuthType} setAuthType={setAAuthType}
          token={aToken} setToken={setAToken}
          cookieName={aCookieName} setCookieName={setACookieName}
          cookieValue={aCookieValue} setCookieValue={setACookieValue}
          username={aUsername} setUsername={setAUsername}
          password={aPassword} setPassword={setAPassword}
          ownedResourceId={aResourceId} setOwnedResourceId={setAResourceId}
        />

        <div>
          <button
            type="button"
            className="text-xs text-primary underline underline-offset-2"
            onClick={() => setShowB(v => !v)}
          >
            {showB ? "Remove Account B (disable cross-account test)" : "+ Add Account B (enables cross-account IDOR test)"}
          </button>
        </div>

        {showB && (
          <AccountCard
            label="Account B (second researcher-owned account)"
            secondary
            authType={bAuthType} setAuthType={setBAuthType}
            token={bToken} setToken={setBToken}
            cookieName={bCookieName} setCookieName={setBCookieName}
            cookieValue={bCookieValue} setCookieValue={setBCookieValue}
            username={bUsername} setUsername={setBUsername}
            password={bPassword} setPassword={setBPassword}
            ownedResourceId={bResourceId} setOwnedResourceId={setBResourceId}
          />
        )}

        {error && <p className="text-sm text-red-600">{error}</p>}

        <Button onClick={runAuthTests} disabled={loading} className="w-full">
          {loading ? "Running auth tests…" : "Run Auth Tests"}
        </Button>

        {result && (
          <div className="space-y-3 pt-2">
            {result.tests.map((t, i) => <AuthTestResultCard key={i} result={t} />)}

            {result.summary && (
              <div className="rounded-md border p-4 space-y-1">
                <p className="text-xs font-semibold uppercase text-muted-foreground">AI Summary</p>
                <p className="text-sm">{result.summary}</p>
              </div>
            )}

            {result.reportDraft?.title && (
              <div className="rounded-md border p-4 space-y-3">
                <p className="text-xs font-semibold uppercase text-muted-foreground">Report Draft</p>
                <p className="text-sm font-medium">{result.reportDraft.title}</p>
                {result.reportDraft.impact && <p className="text-sm">{result.reportDraft.impact}</p>}
                {result.reportDraft.stepsToReproduce?.length > 0 && (
                  <div>
                    <p className="text-xs font-semibold text-muted-foreground mb-1">Steps to Reproduce</p>
                    <ol className="list-decimal list-inside space-y-1">
                      {result.reportDraft.stepsToReproduce.map((s, i) => <li key={i} className="text-sm">{s}</li>)}
                    </ol>
                  </div>
                )}
                {result.reportDraft.evidenceNeeded?.length > 0 && (
                  <div>
                    <p className="text-xs font-semibold text-muted-foreground mb-1">Evidence Needed</p>
                    <ul className="list-disc list-inside space-y-1">
                      {result.reportDraft.evidenceNeeded.map((e, i) => <li key={i} className="text-sm">{e}</li>)}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function ResearchAgentPage() {
  const { apiFetch } = useApi();

  const [savedPrograms,   setSavedPrograms]   = useState<SavedProgram[]>([]);
  const [savingProgram,   setSavingProgram]   = useState(false);
  const [deletingId,      setDeletingId]      = useState<string | null>(null);

  const [programName,  setProgramName]  = useState("");
  const [programRules, setProgramRules] = useState("");
  const [targetUrl,    setTargetUrl]    = useState("");
  const [featureOrFlow,setFeatureOrFlow]= useState("");
  const [notes,        setNotes]        = useState("");

  // Auth
  const [authType,      setAuthType]      = useState<AuthType>("none");
  const [authToken,     setAuthToken]     = useState("");
  const [cookieName,    setCookieName]    = useState("session");
  const [cookieValue,   setCookieValue]   = useState("");
  const [authUsername,  setAuthUsername]  = useState("");
  const [authPassword,  setAuthPassword]  = useState("");
  const [testObjectId,  setTestObjectId]  = useState("");

  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState<string | null>(null);
  const [result,  setResult]  = useState<AnalysisResult | null>(null);

  useEffect(() => {
    apiFetch<{ programs: SavedProgram[] }>("/research-agent/programs")
      .then(d => setSavedPrograms(d.programs))
      .catch(() => {});
  }, []);

  function loadProgram(p: SavedProgram) {
    setProgramName(p.name);
    setProgramRules(p.programRules);
    setTargetUrl(p.targetUrl);
    setFeatureOrFlow(p.featureOrFlow);
    setNotes(p.notes ?? "");
  }

  async function saveProgram() {
    if (!programName || !programRules || !targetUrl || !featureOrFlow) {
      setError("Fill in all required fields before saving."); return;
    }
    setSavingProgram(true);
    try {
      const { program } = await apiFetch<{ program: SavedProgram }>("/research-agent/programs", {
        method: "POST",
        body: JSON.stringify({ name: programName, programRules, targetUrl, featureOrFlow, notes }),
      });
      setSavedPrograms(prev => [program, ...prev]);
    } catch (err: any) {
      setError(err?.message ?? "Save failed");
    } finally {
      setSavingProgram(false);
    }
  }

  async function deleteProgram(id: string) {
    setDeletingId(id);
    try {
      await apiFetch(`/research-agent/programs/${id}`, { method: "DELETE" });
      setSavedPrograms(prev => prev.filter(p => p.id !== id));
    } catch { /* ignore */ } finally {
      setDeletingId(null);
    }
  }

  async function handleAnalyze() {
    if (!programName || !programRules || !targetUrl || !featureOrFlow) {
      setError("All fields except Auth and Notes are required."); return;
    }
    setLoading(true); setError(null); setResult(null);
    try {
      const auth = authType === "bearer"  ? { type: authType, token: authToken, testObjectId: testObjectId || undefined }
                 : authType === "cookie"  ? { type: authType, cookieName, cookieValue, testObjectId: testObjectId || undefined }
                 : authType === "basic"   ? { type: authType, username: authUsername, password: authPassword, testObjectId: testObjectId || undefined }
                 : { type: "none" as const };
      const data = await apiFetch<AnalysisResult>("/research-agent/analyze", {
        method: "POST",
        body: JSON.stringify({ programName, programRules, targetUrl, featureOrFlow, notes, auth }),
      });
      setResult(data);
    } catch (err: any) {
      setError(err?.message ?? "Analysis failed");
    } finally {
      setLoading(false);
    }
  }

  const probe = result?.probe;
  const totalFindings = probe
    ? probe.headerFindings.length + probe.corsFindings.length + probe.pathFindings.length +
      probe.cookieFindings.length + probe.accessFindings.length + probe.idorFindings.length +
      (probe.jwtAnalysis?.findings.length ?? 0)
    : 0;

  return (
    <div className="max-w-4xl mx-auto px-4 py-8 space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Research Agent</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Active passive scanning + authenticated checks — headers, CORS, cookies, broken access control, IDOR, JWT analysis.
        </p>
      </div>

      {/* ── Saved Programs ── */}
      {savedPrograms.length > 0 && (
        <Card>
          <CardHeader><CardTitle className="text-base">Saved Programs</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {savedPrograms.map(p => (
              <div key={p.id} className="flex items-center gap-2 rounded-md border px-3 py-2">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{p.name}</p>
                  <p className="text-xs text-muted-foreground truncate">{p.targetUrl}</p>
                </div>
                <Button variant="ghost" size="sm" onClick={() => loadProgram(p)}>Load</Button>
                <Button
                  variant="ghost" size="sm"
                  className="text-red-500 hover:text-red-700"
                  disabled={deletingId === p.id}
                  onClick={() => deleteProgram(p.id)}
                >
                  {deletingId === p.id ? "…" : "Delete"}
                </Button>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* ── Program & Target ── */}
      <Card>
        <CardHeader><CardTitle className="text-base">Program &amp; Target</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <Input placeholder="Program name (e.g. Acme Security Assessment)" value={programName} onChange={e => setProgramName(e.target.value)} />
          <textarea className="w-full min-h-[90px] rounded-md border px-3 py-2 text-sm resize-y focus:outline-none focus:ring-2 focus:ring-ring" placeholder="Paste program scope / rules" value={programRules} onChange={e => setProgramRules(e.target.value)} />
          <Input placeholder="Target URL (e.g. https://app.example.com/api/orders/123)" value={targetUrl} onChange={e => setTargetUrl(e.target.value)} />
          <textarea className="w-full min-h-[60px] rounded-md border px-3 py-2 text-sm resize-y focus:outline-none focus:ring-2 focus:ring-ring" placeholder="Feature or flow (e.g. order detail page, payment API)" value={featureOrFlow} onChange={e => setFeatureOrFlow(e.target.value)} />
          <textarea className="w-full min-h-[50px] rounded-md border px-3 py-2 text-sm resize-y focus:outline-none focus:ring-2 focus:ring-ring" placeholder="Research notes (optional)" value={notes} onChange={e => setNotes(e.target.value)} />
          <div className="flex justify-end">
            <Button variant="outline" size="sm" onClick={saveProgram} disabled={savingProgram}>
              {savingProgram ? "Saving…" : "Save program"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* ── Auth credentials ── */}
      <Card>
        <CardHeader><CardTitle className="text-base">Authentication (optional — enables deeper checks)</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <Select value={authType} onValueChange={v => setAuthType(v as AuthType)}>
            <SelectTrigger><SelectValue placeholder="Auth type" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="none">None (passive only)</SelectItem>
              <SelectItem value="bearer">Bearer token (JWT / API key)</SelectItem>
              <SelectItem value="cookie">Session cookie</SelectItem>
              <SelectItem value="basic">Basic auth (username + password)</SelectItem>
            </SelectContent>
          </Select>

          {authType === "bearer" && (
            <Input placeholder="Token (e.g. eyJhbGci…)" value={authToken} onChange={e => setAuthToken(e.target.value)} />
          )}
          {authType === "cookie" && (
            <div className="flex gap-2">
              <Input className="w-36" placeholder="Cookie name" value={cookieName} onChange={e => setCookieName(e.target.value)} />
              <Input className="flex-1" placeholder="Cookie value" value={cookieValue} onChange={e => setCookieValue(e.target.value)} />
            </div>
          )}
          {authType === "basic" && (
            <div className="flex gap-2">
              <Input placeholder="Username" value={authUsername} onChange={e => setAuthUsername(e.target.value)} />
              <Input type="password" placeholder="Password" value={authPassword} onChange={e => setAuthPassword(e.target.value)} />
            </div>
          )}
          {authType !== "none" && (
            <Input placeholder="Your test account resource ID (for IDOR checks, e.g. 42 or the ID in the URL)" value={testObjectId} onChange={e => setTestObjectId(e.target.value)} />
          )}
          {authType !== "none" && (
            <p className="text-xs text-muted-foreground">Credentials are used only for scanning this target and are never stored.</p>
          )}
        </CardContent>
      </Card>

      {error && <p className="text-sm text-red-600">{error}</p>}
      <Button onClick={handleAnalyze} disabled={loading} className="w-full">
        {loading ? "Scanning & analyzing…" : "Scan & Analyze"}
      </Button>

      {result && probe && (
        <div className="space-y-4">

          {/* Summary */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-3 flex-wrap">
                Analysis Summary
                <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${SCOPE_CLS[result.scopeStatus] ?? ""}`}>
                  {result.scopeStatus.replace("_", " ")}
                </span>
                <span className="text-xs text-muted-foreground ml-auto">{totalFindings} finding{totalFindings !== 1 ? "s" : ""}</span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm">{result.summary}</p>
              {Object.keys(probe.serverInfo).length > 0 && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {Object.entries(probe.serverInfo).map(([k, v]) => (
                    <span key={k} className="text-xs font-mono bg-muted px-2 py-0.5 rounded">{k}: {v}</span>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Raw probe evidence */}
          {totalFindings > 0 && (
            <Card>
              <CardHeader><CardTitle className="text-base">Probe Evidence</CardTitle></CardHeader>
              <CardContent className="space-y-5">

                <Section title="Broken Access Control" count={probe.accessFindings.length}>
                  {probe.accessFindings.map((f, i) => (
                    <div key={i} className="flex items-start gap-3 py-2 border-t first:border-t-0">
                      <Badge sev={f.severity} />
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-mono text-muted-foreground truncate">{f.url}</p>
                        <p className="text-sm">{f.issue}</p>
                        <p className="text-xs text-muted-foreground mt-0.5">Unauth: HTTP {f.unauthStatus}{f.authStatus ? ` | Auth: HTTP ${f.authStatus}` : ""}</p>
                      </div>
                    </div>
                  ))}
                </Section>

                <Section title="IDOR" count={probe.idorFindings.length}>
                  {probe.idorFindings.map((f, i) => (
                    <div key={i} className="flex items-start gap-3 py-2 border-t first:border-t-0">
                      <Badge sev={f.severity} />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm">{f.issue}</p>
                        <p className="text-xs font-mono text-muted-foreground mt-0.5">Tested: {f.testUrl}</p>
                        <p className="text-xs text-muted-foreground">ID {f.originalId} → {f.testId} both returned HTTP {f.testStatus}</p>
                      </div>
                    </div>
                  ))}
                </Section>

                {probe.jwtAnalysis && (
                  <Section title="JWT Analysis" count={probe.jwtAnalysis.findings.length}>
                    <div className="space-y-1 mb-2">
                      <p className="text-xs text-muted-foreground">Algorithm: <span className="font-mono">{probe.jwtAnalysis.algorithm ?? "—"}</span></p>
                      {probe.jwtAnalysis.expiresAt && <p className="text-xs text-muted-foreground">Expires: {probe.jwtAnalysis.expiresAt}</p>}
                      <details className="text-xs">
                        <summary className="cursor-pointer text-muted-foreground hover:text-foreground">View decoded payload</summary>
                        <pre className="mt-1 p-2 bg-muted rounded text-xs overflow-x-auto">{JSON.stringify(probe.jwtAnalysis.payload, null, 2)}</pre>
                      </details>
                    </div>
                    {probe.jwtAnalysis.findings.map((f, i) => (
                      <div key={i} className="flex items-start gap-3 py-2 border-t first:border-t-0">
                        <Badge sev={f.severity} />
                        <p className="text-sm">{f.issue}</p>
                      </div>
                    ))}
                  </Section>
                )}

                <Section title="Cookie Security" count={probe.cookieFindings.length}>
                  {probe.cookieFindings.map((f, i) => <FindingRow key={i} f={f} />)}
                </Section>

                <Section title="CORS" count={probe.corsFindings.length}>
                  {probe.corsFindings.map((f, i) => <FindingRow key={i} f={f} />)}
                </Section>

                <Section title="Security Headers" count={probe.headerFindings.length}>
                  {probe.headerFindings.map((f, i) => <FindingRow key={i} f={f} />)}
                </Section>

                <Section title="Exposed Paths" count={probe.pathFindings.length}>
                  {probe.pathFindings.map((f, i) => <FindingRow key={i} f={f} />)}
                </Section>

              </CardContent>
            </Card>
          )}

          {/* Prioritized risk areas */}
          {result.riskAreas?.length > 0 && (
            <Card>
              <CardHeader><CardTitle className="text-base">Prioritized Risk Areas</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                {result.riskAreas.map((risk, i) => (
                  <div key={i} className="border rounded-md p-4 space-y-2">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-semibold text-sm">{risk.area}</span>
                      <Badge sev={risk.severity} />
                      <Badge sev={risk.reportability} label={`reportability: ${risk.reportability}`} />
                    </div>
                    <p className="text-sm"><span className="font-medium">Finding:</span> {risk.actualFinding}</p>
                    <p className="text-sm"><span className="font-medium">Why it matters:</span> {risk.whyItMatters}</p>

                    {risk.manualVerificationSteps?.length > 0 && (
                      <div className="mt-1 rounded-md bg-muted/50 border p-3 space-y-2">
                        <p className="text-xs font-semibold uppercase text-muted-foreground">Manual verification steps</p>
                        {risk.manualVerificationSteps.map((s, j) => (
                          <div key={j} className="flex gap-3">
                            <span className="flex-shrink-0 w-5 h-5 rounded-full bg-primary/10 text-primary text-xs font-bold flex items-center justify-center mt-0.5">{s.step}</span>
                            <div className="space-y-0.5">
                              <p className="text-sm">{s.action}</p>
                              <p className="text-xs text-muted-foreground"><span className="font-medium">Expected:</span> {s.expectedResult}</p>
                              <span className="inline-block text-[10px] font-mono bg-background border rounded px-1.5 py-0.5">{s.tool}</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          {/* Report draft */}
          {result.reportDraft && (
            <Card>
              <CardHeader><CardTitle className="text-base">Report Draft</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                <div>
                  <p className="text-xs font-semibold uppercase text-muted-foreground mb-1">Title</p>
                  <p className="text-sm font-medium">{result.reportDraft.title}</p>
                </div>
                <div>
                  <p className="text-xs font-semibold uppercase text-muted-foreground mb-1">Impact</p>
                  <p className="text-sm">{result.reportDraft.impact}</p>
                </div>
                {result.reportDraft.stepsToReproduce?.length > 0 && (
                  <div>
                    <p className="text-xs font-semibold uppercase text-muted-foreground mb-1">Steps to Reproduce</p>
                    <ol className="list-decimal list-inside space-y-1">
                      {result.reportDraft.stepsToReproduce.map((s, i) => <li key={i} className="text-sm">{s}</li>)}
                    </ol>
                  </div>
                )}
                {result.reportDraft.evidenceNeeded?.length > 0 && (
                  <div>
                    <p className="text-xs font-semibold uppercase text-muted-foreground mb-1">Evidence Needed</p>
                    <ul className="list-disc list-inside space-y-1">
                      {result.reportDraft.evidenceNeeded.map((e, i) => <li key={i} className="text-sm">{e}</li>)}
                    </ul>
                  </div>
                )}
              </CardContent>
            </Card>
          )}
        </div>
      )}

      <AuthTestSection targetUrl={targetUrl} programRules={programRules} />
    </div>
  );
}
