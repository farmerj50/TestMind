export type WorkflowEvidence = { id: string; kind: 'assertion' | 'trace' | 'screenshot' | 'network' | 'api-response' | 'backend-log' | 'runner-log'; runId: string; caseId?: string; requestId?: string; timestamp?: string; message?: string; status?: number; failureClass?: string; artifactId?: string };

// Deterministic evidence correlation. An attachment's presence alone is not a
// diagnosis. Ambiguous or contradictory signals stay unknown for review.
export function analyzeWorkflowEvidence(evidence: WorkflowEvidence[]) {
  const failures = evidence.filter(e => e.kind === 'assertion' && e.failureClass !== 'passed');
  const findings = failures.map(failure => {
    const related = evidence.filter(e => e.runId === failure.runId && (e.id === failure.id || (failure.caseId && e.caseId === failure.caseId) || (failure.requestId && e.requestId === failure.requestId)));
    const messages = related.filter(e => e.message).map(e => e.message!.toLowerCase()).join('\n');
    const infrastructure = /econnrefused|enotfound|err_connection|browser.*(crash|closed)|out of memory|disk.*full|connection reset/.test(messages);
    let missingGeneratedAction = false;
    try {
      const diagnostic = JSON.parse((failure.message ?? '').replace(/^Error:\s*/, ''));
      missingGeneratedAction = diagnostic.code === 'GENERATED_LOCATOR_MISSING' &&
        ['fill', 'click', 'upload', 'expect-visible'].includes(diagnostic.action) &&
        typeof diagnostic.locator === 'string' && diagnostic.locator.length > 0;
    } catch { /* Generic assertion text remains insufficient evidence. */ }
    const automation = missingGeneratedAction || /strict mode violation|invalid selector|syntaxerror|locator.*(not found|resolved to 0)/.test(messages);
    const serverError = related.some(e => ['api-response', 'network'].includes(e.kind) && (e.status ?? 0) >= 500);
    // A 5xx can also come from a proxy, dependency or infrastructure outage.
    // Require application-specific backend evidence before calling it a defect.
    const application = related.some(e => e.kind === 'backend-log' && e.failureClass === 'application-error');
    const matches = [infrastructure && 'infrastructure-failure', automation && 'automation-failure', application && 'application-defect'].filter(Boolean);
    const verdict = matches.length === 1 ? matches[0] : 'unknown';
    return { caseId: failure.caseId ?? null, verdict, evidenceIds: related.map(e => e.id),
      confidence: verdict === 'unknown' ? 'insufficient' : 'supported',
      hypotheses: serverError && !application ? ['Application, dependency, or infrastructure error: server response alone does not distinguish the cause.'] : [],
      explanation: verdict === 'unknown' ? 'Available evidence is insufficient or conflicting.' : 'Classification is supported by correlated execution evidence.',
      missingEvidence: ['trace', 'screenshot', 'network', 'api-response', 'backend-log'].filter(kind => !related.some(e => e.kind === kind)) };
  });
  const distinct = new Set(findings.map(f => f.verdict));
  return { verdict: distinct.size === 1 ? findings[0].verdict : 'unknown', evidenceIds: [...new Set(findings.flatMap(f => f.evidenceIds))], findings, evidence,
    limitation: 'Screenshots and trace attachments are linked as evidence; their presence does not prove a root cause.' };
}
