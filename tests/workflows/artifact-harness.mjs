import fs from 'node:fs';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import * as core from '../../packages/testmind-core/workflow/index.js';
import { loadTs } from './operator-harness.mjs';
const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(import.meta.url);
const { tsImport } = require('tsx/esm/api');
export const archive = await tsImport(pathToFileURL(path.join(root, 'apps/api/src/lib/trace-archive.ts')).href, import.meta.url);
export const sanitizer = await tsImport(pathToFileURL(path.join(root, 'apps/api/src/lib/trace-sanitizer.ts')).href, import.meta.url);
const sourceExport = await tsImport(pathToFileURL(path.join(root, 'apps/api/src/lib/source-export.ts')).href, import.meta.url);
export function artifactModules(prisma, reportRoot, encryption) {
  const service = loadTs('apps/api/src/lib/artifact-service.ts', {
    'node:fs/promises': fs.promises, 'node:fs': fs, 'node:crypto': crypto, '../prisma.js': { prisma }, './crypto.js': encryption,
    './storageRoots.js': { REPORT_ROOT: reportRoot }, '@testmind/core/workflow': core, './trace-archive.js': archive, './trace-sanitizer.js': sanitizer,
  }, { TextDecoder });
  const auth = loadTs('apps/api/src/lib/run-access.ts', { '@clerk/fastify': { getAuth: req => ({ userId: req.headers['x-user-id'] }) }, '../prisma.js': { prisma } });
  const routes = loadTs('apps/api/src/routes/artifacts.ts', { 'node:fs/promises': fs.promises, '../lib/source-export.js': sourceExport, '../lib/run-access.js': auth, '../lib/storageRoots.js': { REPORT_ROOT: reportRoot }, '../lib/artifact-service.js': service });
  return { service, routes };
}
