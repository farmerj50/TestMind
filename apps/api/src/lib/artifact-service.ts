import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { prisma } from '../prisma.js';
import { decryptSecret } from './crypto.js';
import { REPORT_ROOT } from './storageRoots.js';
import { redactWorkflowValue } from '@testmind/core/workflow';
import { ArtifactSecurityError, blocked, TRACE_LIMITS } from './trace-archive.js';
import { sanitizeTrace, TRACE_SANITIZER_VERSION } from './trace-sanitizer.js';

export { ArtifactSecurityError };
const inFlight = new Map<string, Promise<Buffer>>();
export const artifactIdSafe = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value);
export const within = (root: string, file: string) => { const rel = path.relative(root, file); return rel !== '' && !rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel); };
export function artifactSecurityResponse(reply: any) { return reply.code(422).header('Cache-Control', 'private, no-store').type('application/json').send({ error: 'ARTIFACT_SECURITY_BLOCKED', message: new ArtifactSecurityError().message }); }
export async function projectArtifactSecrets(projectId: string) {
  // Failure to resolve/decrypt the redaction set is a security failure, never an
  // instruction to return the original artifact or proceed with an empty set.
  try { return (await prisma.projectSecret.findMany({ where: { projectId }, select: { value: true } })).map(secret => decryptSecret(secret.value)); }
  catch { return blocked(); }
}
export async function readBoundedArtifact(root: string, candidate: string) {
  const realRoot = await fs.realpath(root), realFile = await fs.realpath(candidate);
  if (realRoot !== path.join(await fs.realpath(path.dirname(root)), path.basename(root))) blocked();
  if (!within(realRoot, realFile)) blocked();
  const handle = await fs.open(realFile, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > TRACE_LIMITS.archive) blocked();
    const data = Buffer.alloc(before.size); let offset = 0;
    while (offset < data.length) { const read = await handle.read(data, offset, data.length - offset, offset); if (!read.bytesRead) blocked(); offset += read.bytesRead; }
    const after = await handle.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino || before.dev !== after.dev) blocked();
    return { data, file: realFile };
  } finally { await handle.close(); }
}
async function writePrivate(directory: string, file: string, bytes: Buffer) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const actual = await fs.realpath(directory);
  if (actual !== path.resolve(directory)) blocked();
  const dest = path.join(actual, file);
  // Never trust an existing disk cache as an already-sanitized object. Callers
  // return freshly validated bytes; this immutable file is an audit derivative.
  try { await fs.writeFile(dest, bytes, { flag: 'wx', mode: 0o600 }); }
  catch (error: any) { if (error.code !== 'EEXIST') throw error; }
}
async function sanitizedCopy(data: Buffer, projectId: string, runId: string, secrets: string[]) {
  const digest = crypto.createHash('sha256').update(data).digest('hex');
  const scope = crypto.createHash('sha256').update(projectId).update('\0').update(runId).digest('hex');
  const policy = crypto.createHash('sha256').update(TRACE_SANITIZER_VERSION).update(JSON.stringify(secrets)).digest('hex');
  const key = `${scope}/${digest}/${policy}`;
  if (inFlight.has(key)) return inFlight.get(key)!;
  if (inFlight.size >= 4) blocked();
  const operation = (async () => {
    const base = path.join(REPORT_ROOT, '.private-artifacts', scope);
    await writePrivate(path.join(base, 'originals'), `${digest}.zip`, data);
    const sanitized = sanitizeTrace(data, secrets);
    const safeDigest = crypto.createHash('sha256').update(sanitized).digest('hex');
    await writePrivate(path.join(base, 'sanitized', policy), `${safeDigest}.zip`, sanitized);
    return sanitized;
  })();
  inFlight.set(key, operation);
  try { return await operation; } catch { return blocked(); } finally { inFlight.delete(key); }
}
export function publicArtifactJson(value: any, secrets: string[] = []): any {
  // Embedded ZIP/base64 bodies and external storage references cannot provide a
  // second path around trace validation. Ordinary report metadata is retained.
  const visit = (item: any, depth = 0): any => {
    if (depth > 80) blocked();
    if (typeof item === 'string') {
      if (/UEsDB|UEsFB|data:[^,]*;base64,/i.test(item)) return '[artifact content withheld]';
      return item;
    }
    if (Array.isArray(item)) return item.map(value => visit(value, depth + 1));
    if (item instanceof Date) return item.toISOString();
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([key, value]) => [key, /^(body|base64|buffer|storageState|message|error|stack|stdout|stderr)$/i.test(key) ? '[artifact content withheld]' : visit(value, depth + 1)]));
    return item;
  };
  return redactWorkflowValue(visit(value), secrets);
}
/**
 * Data files of a run's generated Allure report (allure-report/data, widgets, history, export).
 * The report UI needs test names, statuses and failure messages, so text is kept - but every
 * string is still redacted for known project secrets, credential-shaped text and sensitive keys,
 * and embedded archives/base64 or body/buffer/storageState payloads are still withheld.
 */
export function allureReportJson(value: any, secrets: string[]): any {
  const visit = (item: any, depth = 0): any => {
    if (depth > 80) blocked();
    if (typeof item === 'string') return /UEsDB|UEsFB|data:[^,]*;base64,/i.test(item) ? '[artifact content withheld]' : item;
    if (Array.isArray(item)) return item.map(entry => visit(entry, depth + 1));
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([key, entry]) => [key, /^(body|base64|buffer|storageState)$/i.test(key) ? '[artifact content withheld]' : visit(entry, depth + 1)]));
    return item;
  };
  return redactWorkflowValue(visit(value), secrets);
}
const isAllureReportFile = (root: string, file: string) => path.relative(root, file).split(path.sep)[0] === 'allure-report';
function publicReportProjection(value: any, depth = 0): any {
  if (depth > 80) blocked();
  if (Array.isArray(value)) return value.map(item => publicReportProjection(item, depth + 1));
  if (value && typeof value === 'object') {
    const fields = new Set('suites specs tests results attachments errors stats counts assertions children steps status outcome duration durationMs startTime endTime total passed failed skipped errors expected unexpected flaky retried retries workerIndex parallelIndex retry line column ok timeout'.split(' '));
    return Object.fromEntries(Object.entries(value).map(([key, item], index) => fields.has(key)
      ? [key, publicReportProjection(item, depth + 1)] : [`withheld-${index}`, '[artifact content withheld]']));
  }
  if (typeof value === 'string') return ['passed', 'failed', 'skipped', 'timedOut', 'interrupted', 'expected', 'unexpected', 'flaky', 'queued', 'running', 'succeeded', 'canceled'].includes(value) ? value : '[artifact content withheld]';
  return value;
}
/** Exact redaction of known project secret values (and their bare form after a Bearer/Basic/token prefix). */
export function redactKnownSecrets(text: string, secrets: string[]): string {
  const values = new Set<string>();
  for (const raw of secrets) {
    if (typeof raw !== 'string' || !raw) continue;
    values.add(raw);
    const bare = raw.match(/^(?:bearer|basic|token)\s+(.+)$/i)?.[1];
    if (bare) values.add(bare);
  }
  let out = text;
  for (const value of [...values].sort((a, b) => b.length - a.length)) if (out.includes(value)) out = out.split(value).join('[redacted]');
  return out;
}
export async function downloadableArtifact(input: { root: string; candidate: string; projectId: string; runId: string; trace?: boolean }) {
  if (!artifactIdSafe(input.runId) || !artifactIdSafe(input.projectId)) blocked();
  const { data, file } = await readBoundedArtifact(input.root, input.candidate);
  const secrets = await projectArtifactSecrets(input.projectId);
  const ext = path.extname(file).toLowerCase();
  if (input.trace || ext === '.zip' || data.subarray(0, 2).toString() === 'PK') return { data: await sanitizedCopy(data, input.projectId, input.runId, secrets), type: 'application/zip', sanitized: true };
  // Pixels, active report documents and free-form logs cannot be proven free of
  // runtime secrets. Retain originals, but fail closed at every download alias.
  if (/\.(trace|network|stacks|har|gz|br|tar|7z)$/i.test(file) || /(?:^|[\\/])(resources|\.private-artifacts|\.pw-cache|\.auth)(?:[\\/]|$)/i.test(file)) blocked();
  const types: Record<string, string> = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.txt': 'text/plain', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webm': 'video/webm', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf' };
  if (!types[ext]) blocked();
  if (ext === '.json') {
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(data);
      if (/"type"\s*:\s*"(?:context-options|resource-snapshot|frame-snapshot)"/.test(text)) blocked();
      const parsed = JSON.parse(text);
      if (isAllureReportFile(await fs.realpath(input.root), file)) return { data: Buffer.from(JSON.stringify(allureReportJson(parsed, secrets))), type: types[ext], sanitized: false };
      return { data: Buffer.from(JSON.stringify(publicArtifactJson(publicReportProjection(parsed), secrets))), type: types[ext], sanitized: false };
    } catch { return blocked(); }
  }
  // Text-based report/log assets: redact known project secrets and reject anything
  // smuggling raw trace-event content under a different extension, same as .json.
  if (['.html', '.js', '.css', '.svg', '.txt'].includes(ext)) {
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(data);
      if (/"type"\s*:\s*"(?:context-options|resource-snapshot|frame-snapshot)"/.test(text)) blocked();
      // Logs get every known secret plus credential-shaped text redacted. Report code assets
      // (Allure/Playwright app.js, styles, HTML shells) get every known project secret value
      // redacted, but not the credential-shape heuristic: it rewrites ordinary minified code
      // such as `{key:"toHtml",value:function(t){...` and breaks the report.
      const redacted = ext === '.txt' ? redactWorkflowValue(text, secrets) : redactKnownSecrets(text, secrets);
      return { data: Buffer.from(redacted), type: types[ext], sanitized: false };
    } catch { return blocked(); }
  }
  // Remaining allowlisted types are binary (images/fonts/video) and cannot carry a
  // string-matchable secret; serve as-is.
  return { data, type: types[ext], sanitized: false };
}
export async function sendRunArtifact(req: any, reply: any, owner: { runId: string; projectId: string }, roots: string[], relative: string) {
  if (!artifactIdSafe(owner.runId) || relative.includes('\\') || relative.includes('\0') || relative.split('/').some(part => ['..', '.', '.private-artifacts', '.pw-cache', '.auth'].includes(part))) return artifactSecurityResponse(reply);
  for (const root of roots) {
    const base = path.resolve(root, owner.runId), target = path.resolve(base, relative || 'index.html');
    if (!within(base, target)) return artifactSecurityResponse(reply);
    let candidate = target;
    try { if ((await fs.stat(candidate)).isDirectory()) candidate = path.join(candidate, 'index.html'); }
    catch (error: any) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') continue; return artifactSecurityResponse(reply); }
    try {
      const artifact = await downloadableArtifact({ root: base, candidate, projectId: owner.projectId, runId: owner.runId });
      reply.header('Cache-Control', 'private, no-store').header('X-Content-Type-Options', 'nosniff').type(artifact.type);
      if (artifact.sanitized) reply.header('Content-Disposition', 'attachment; filename="sanitized-trace.zip"').header('X-TestMind-Artifact-Policy', TRACE_SANITIZER_VERSION);
      return reply.send(artifact.data);
    } catch { return artifactSecurityResponse(reply); } // never try a legacy/raw fallback after a security failure
  }
  return reply.code(404).send({ error: 'Artifact not found' });
}
