/**
 * API capability — execute HTTP requests.
 *
 * Supported actions: get, post, put, patch, delete, head
 *
 * input.target  = URL
 * input.params  = { headers?, body?, timeout? }
 */

import type { CapabilityInput, CapabilityOutput, ExecutionContext } from './types.js';

const ALLOWED_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head']);
const DEFAULT_TIMEOUT_MS = 15_000;

export async function runApiCapability(
  input: CapabilityInput,
  _ctx: ExecutionContext,
): Promise<CapabilityOutput> {
  const method = input.action.toLowerCase();
  if (!ALLOWED_METHODS.has(method)) {
    return { success: false, error: `Unknown API action: ${input.action}` };
  }

  const url = input.target;
  if (!url) return { success: false, error: 'api capability requires a target URL' };

  const params = (input.params ?? {}) as Record<string, unknown>;
  const headers = (params.headers ?? {}) as Record<string, string>;
  const body = params.body !== undefined ? JSON.stringify(params.body) : undefined;
  const timeoutMs = Number(params.timeout ?? DEFAULT_TIMEOUT_MS);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: method.toUpperCase(),
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
      body: method === 'get' || method === 'head' ? undefined : body,
      signal: controller.signal,
    });

    let data: unknown;
    const contentType = res.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      data = await res.json();
    } else {
      data = await res.text();
    }

    return {
      success: res.ok,
      data: { status: res.status, headers: Object.fromEntries(res.headers), body: data },
      error: res.ok ? undefined : `HTTP ${res.status} ${res.statusText}`,
    };
  } catch (err: any) {
    return { success: false, error: err?.message ?? String(err) };
  } finally {
    clearTimeout(timer);
  }
}
