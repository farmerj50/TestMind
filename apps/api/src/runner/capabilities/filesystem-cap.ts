/**
 * Filesystem capability — read, write, list, exists.
 *
 * Write/delete actions should be gated by the caller when the
 * path is outside the project workDir sandbox.
 *
 * input.target = file or directory path
 * input.params = { encoding?, content?, recursive? }
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type { CapabilityInput, CapabilityOutput, ExecutionContext } from './types.js';

const MAX_READ_BYTES = 100_000;

export async function runFilesystemCapability(
  input: CapabilityInput,
  ctx: ExecutionContext,
): Promise<CapabilityOutput> {
  const target = input.target;
  if (!target) return { success: false, error: 'filesystem capability requires a target path' };

  // Resolve relative to workDir when not absolute
  const resolved = path.isAbsolute(target)
    ? target
    : path.resolve(ctx.workDir ?? process.cwd(), target);

  const params = (input.params ?? {}) as Record<string, unknown>;

  switch (input.action) {
    case 'read': {
      try {
        const encoding = (params.encoding as BufferEncoding | undefined) ?? 'utf-8';
        const buf = await fs.readFile(resolved);
        const content =
          buf.length > MAX_READ_BYTES
            ? buf.subarray(0, MAX_READ_BYTES).toString(encoding) + '\n… (truncated)'
            : buf.toString(encoding);
        return { success: true, data: { path: resolved, content, size: buf.length } };
      } catch (err: any) {
        return { success: false, error: err?.message ?? String(err) };
      }
    }

    case 'write': {
      const content = params.content as string | undefined;
      if (content === undefined) return { success: false, error: 'write action requires params.content' };
      try {
        await fs.mkdir(path.dirname(resolved), { recursive: true });
        await fs.writeFile(resolved, content, 'utf-8');
        return { success: true, data: { path: resolved, bytesWritten: Buffer.byteLength(content) } };
      } catch (err: any) {
        return { success: false, error: err?.message ?? String(err) };
      }
    }

    case 'list': {
      try {
        const recursive = params.recursive === true;
        if (recursive) {
          const entries: string[] = [];
          async function walk(dir: string) {
            const items = await fs.readdir(dir, { withFileTypes: true });
            for (const item of items) {
              const full = path.join(dir, item.name);
              entries.push(path.relative(resolved, full) + (item.isDirectory() ? '/' : ''));
              if (item.isDirectory() && !item.name.startsWith('.') && item.name !== 'node_modules') {
                await walk(full);
              }
            }
          }
          await walk(resolved);
          return { success: true, data: { path: resolved, entries } };
        } else {
          const items = await fs.readdir(resolved, { withFileTypes: true });
          const entries = items.map((i) => i.name + (i.isDirectory() ? '/' : ''));
          return { success: true, data: { path: resolved, entries } };
        }
      } catch (err: any) {
        return { success: false, error: err?.message ?? String(err) };
      }
    }

    case 'exists': {
      try {
        const stat = await fs.stat(resolved);
        return {
          success: true,
          data: { path: resolved, exists: true, isFile: stat.isFile(), isDirectory: stat.isDirectory(), size: stat.size },
        };
      } catch {
        return { success: true, data: { path: resolved, exists: false } };
      }
    }

    case 'delete': {
      try {
        await fs.rm(resolved, { recursive: true, force: true });
        return { success: true, data: { path: resolved, deleted: true } };
      } catch (err: any) {
        return { success: false, error: err?.message ?? String(err) };
      }
    }

    default:
      return { success: false, error: `Unknown filesystem action: ${input.action}` };
  }
}
