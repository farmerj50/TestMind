import fs from 'node:fs/promises';
import path from 'node:path';
import { blocked } from './trace-archive.js';

const allowed = /\.(?:[cm]?[jt]sx?|json|feature|ya?ml|md|txt)$/i;
const excluded = /^(?:\..*|node_modules|test-results|playwright-report|runner-logs|allure-results|allure-report|resources)$/i;
export function assertSourceExportConfidential(bytes: Buffer, secrets: string[]) {
  const text = bytes.toString('utf8');
  const variants = secrets.filter(Boolean).flatMap(secret => [secret, encodeURIComponent(secret), Buffer.from(secret).toString('base64'), Buffer.from(secret).toString('base64url'), JSON.stringify(secret).slice(1, -1)]);
  if (variants.some(value => text.includes(value)) || /(?:password|passwd|secret|token|api[_-]?key|authorization|cookie)\s*["']?\s*[:=]\s*["'`][^"'`]+["'`]/i.test(text)) blocked();
}
export function checkedSourceBytes(file: string, bytes: Buffer) {
  if (!allowed.test(file) || bytes.length > 8_000_000 || bytes.subarray(0, 2).toString() === 'PK') blocked();
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (text.includes('\0') || /UEsDB|UEsFB|data:application\/(?:zip|octet-stream)|"type"\s*:\s*"(?:context-options|resource-snapshot|frame-snapshot)"/i.test(text)) blocked();
    return bytes;
  } catch { return blocked(); }
}
export async function readExportSource(root: string, file: string) {
  const actualRoot = await fs.realpath(root), actualFile = await fs.realpath(file), relative = path.relative(actualRoot, actualFile);
  if (actualRoot !== path.join(await fs.realpath(path.dirname(root)), path.basename(root))) blocked();
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || relative.split(path.sep).some(part => excluded.test(part))) blocked();
  if ((await fs.lstat(file)).isSymbolicLink() || !(await fs.stat(actualFile)).isFile() || (await fs.stat(actualFile)).size > 8_000_000) blocked();
  return checkedSourceBytes(actualFile, await fs.readFile(actualFile));
}
export async function sourceBundleFiles(root: string) {
  const files: { name: string; data: Buffer }[] = []; let total = 0, count = 0;
  const walk = async (folder: string, depth = 0) => {
    if (depth > 20) blocked();
    for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
      if (++count > 4096) blocked();
      if (entry.isSymbolicLink()) blocked();
      if (excluded.test(entry.name)) continue;
      const target = path.join(folder, entry.name);
      if (entry.isDirectory()) await walk(target, depth + 1);
      else if (entry.isFile() && allowed.test(entry.name)) {
        const data = await readExportSource(root, target); total += data.length;
        if (total > 32_000_000 || files.length >= 2048) blocked();
        files.push({ name: path.relative(root, target).split(path.sep).join('/'), data });
      }
    }
  };
  await walk(root); return files;
}
