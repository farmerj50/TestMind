import path from 'node:path';
import fs from 'node:fs/promises';
import { prisma } from '../prisma.js';
import { REPORT_ROOT } from '../lib/storageRoots.js';
import type { WorkflowEvidence } from '../lib/workflow-evidence.js';
import { parseResults } from './result-parsers.js';

async function boundedFile(root: string, candidate: string, maxBytes = 8_000_000) {
  const [realRoot, realFile] = await Promise.all([fs.realpath(root), fs.realpath(candidate)]);
  const relative = path.relative(realRoot, realFile);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Evidence path escapes the run directory');
  if ((await fs.stat(realFile)).size > maxBytes) throw new Error('Evidence exceeds analysis size limit');
  return { path: realFile, content: await fs.readFile(realFile) };
}
export async function collectWorkflowRunEvidence(projectId: string, result: any, jobId: string, taskId: string): Promise<WorkflowEvidence[]> {
  if (typeof result?.runId !== 'string') throw new Error('Evidence analysis requires a recorded test run');
  const runId = result.runId;
  const evidence: WorkflowEvidence[] = [];
  if (result.source === 'api') {
    const run = await prisma.apiTestRun.findFirst({ where: { id: runId, projectId }, include: { results: true } });
    if (!run) throw new Error('API evidence is outside this project');
    for (const row of run.results) {
      const requestId = typeof (row.responseHeaders as any)?.['x-request-id'] === 'string' ? (row.responseHeaders as any)['x-request-id'] : undefined;
      evidence.push({ id: row.id, kind: 'assertion', runId, caseId: row.testCaseId, requestId, failureClass: row.status, message: row.error ?? JSON.stringify(row.assertionResults) });
      evidence.push({ id: `${row.id}-response`, kind: 'api-response', runId, caseId: row.testCaseId, requestId, status: row.statusCode ?? undefined });
    }
    return evidence;
  }
  const run = await prisma.testRun.findFirst({ where: { id: runId, projectId }, include: { results: { include: { testCase: true } } } });
  if (!run) throw new Error('UI evidence is outside this project');
  for (const row of run.results) evidence.push({ id: row.id, kind: 'assertion', runId, caseId: row.testCaseId, failureClass: row.status, message: row.message ?? undefined });
  const root = path.join(REPORT_ROOT, 'runner-logs', runId);
  let report: any;
  try { report = JSON.parse((await boundedFile(root, path.join(root, 'report.json'))).content.toString('utf8')); }
  catch { return evidence; } // unavailable evidence remains explicitly missing in analysis
  const cases = await parseResults('', report);
  for (const entry of cases) {
    const matching = run.results.filter(r => r.testCase.title === entry.fullName);
    // Never associate a screenshot/network exchange with a guessed case.
    if (matching.length !== 1) continue;
    const caseId = matching[0].testCaseId;
    for (const [index, attachment] of (entry.attachments ?? []).entries()) {
      const kind = /trace/i.test(attachment.name) ? 'trace' : attachment.contentType?.startsWith('image/') ? 'screenshot' : /backend/i.test(attachment.name) ? 'backend-log' : /network|page-signals|har/i.test(attachment.name) ? 'network' : 'runner-log';
      let content: Buffer | undefined, artifactId: string | undefined;
      if (attachment.path) {
        try {
          const file = await boundedFile(root, path.resolve(root, attachment.path));
          content = file.content;
          const existing = await prisma.operatorArtifact.findFirst({ where: { taskId, path: file.path } });
          const artifact = existing ?? await prisma.operatorArtifact.create({ data: { jobId, taskId, testRunId: runId, type: kind === 'backend-log' || kind === 'runner-log' ? 'console' : kind, path: file.path, metaJson: { caseId, evidenceKind: kind } } });
          artifactId = artifact.id;
        } catch { continue; }
      } else if (attachment.body && attachment.body.length < 1_000_000) content = Buffer.from(attachment.body, 'base64');
      const id = `${matching[0].id}-attachment-${index}`;
      evidence.push({ id, kind, runId, caseId, artifactId });
      if (content && ['network', 'backend-log', 'runner-log'].includes(kind)) {
        try {
          const payload = JSON.parse(content.toString('utf8'));
          const signals = payload.signals ?? payload;
          for (const [i, response] of (signals.responses ?? []).slice(0, 500).entries()) evidence.push({ id: `${id}-response-${i}`, kind: 'network', runId, caseId, status: response.status, requestId: response.requestId, artifactId });
          for (const [i, request] of (signals.requestFailed ?? []).slice(0, 100).entries()) evidence.push({ id: `${id}-request-${i}`, kind: 'network', runId, caseId, message: request.errorText, artifactId });
          if (kind === 'backend-log') for (const [i, event] of (payload.events ?? []).slice(0, 100).entries()) evidence.push({ id: `${id}-event-${i}`, kind, runId, caseId, requestId: event.requestId, message: String(event.message ?? '').slice(0, 1000), failureClass: event.failureClass, artifactId });
        } catch { evidence.push({ id: `${id}-text`, kind, runId, caseId, message: content.toString('utf8').slice(0, 4000), artifactId }); }
      }
    }
  }
  return evidence;
}
