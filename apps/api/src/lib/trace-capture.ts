import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

// A per-execution wrapper beside the original config preserves relative paths.
// Never rewrite the user's config. Browser authentication and standalone failure
// screenshots remain unchanged; embedded trace pixels/sources/attachments stop at capture.
const WRAPPER_NAME = /^\.tm-trace-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.config\.mjs$/;
/** Older than any run can last (default run timeout is 10 minutes). */
export const STALE_TRACE_WRAPPER_MS = 12 * 60 * 60 * 1000;

/**
 * Wrappers are removed when their run finishes; a process restart or crash mid-run skips that.
 * Each new wrapper therefore sweeps abandoned siblings that are older than any live run.
 */
export async function removeStaleTraceWrappers(dir: string, now = Date.now(), maxAgeMs = STALE_TRACE_WRAPPER_MS): Promise<string[]> {
  const removed: string[] = [];
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  for (const name of names) {
    if (!WRAPPER_NAME.test(name)) continue;
    const file = path.join(dir, name);
    const stat = await fs.stat(file).catch(() => null);
    if (!stat?.isFile() || now - stat.mtimeMs < maxAgeMs) continue;
    if (await fs.unlink(file).then(() => true, () => false)) removed.push(name);
  }
  return removed;
}

export async function createRestrictedTraceConfig(config: string, outputDir: string, requestedMode?: string) {
  await removeStaleTraceWrappers(path.dirname(config));
  const wrapper = path.join(path.dirname(config), `.tm-trace-${randomUUID()}.config.mjs`);
  const text = `import original from ${JSON.stringify(pathToFileURL(config).href)};
const base = original?.default ?? original;
const forced = ${JSON.stringify(requestedMode ?? null)};
const trace = current => ({ ...(typeof current === 'object' ? current : {}), mode: forced ?? (typeof current === 'object' ? current.mode : current) ?? 'off', screenshots: false, sources: false, attachments: false });
export default { ...base, outputDir: ${JSON.stringify(outputDir)}, use: { ...base.use, trace: trace(base.use?.trace) }, ...(base.projects ? { projects: base.projects.map((project, index) => ({ ...project, outputDir: ${JSON.stringify(outputDir)} + '/project-' + index, use: { ...project.use, trace: trace(project.use?.trace ?? base.use?.trace) } })) } : {}) };
`;
  await fs.writeFile(wrapper, text, { flag: 'wx', mode: 0o600 });
  return { path: wrapper, remove: () => fs.unlink(wrapper).catch(() => {}) };
}
