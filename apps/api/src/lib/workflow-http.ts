import { safeFetch, validateUrl } from './safe-fetch.js';

export async function validateWorkflowTarget(rawUrl: string, environment: any) {
  const url = await validateUrl(rawUrl, { allowHttp: true });
  if (url.username || url.password) throw new Error('Use a scoped secret reference for credentials');
  if (environment && url.origin !== new URL(environment.baseUrl).origin) throw new Error('Target is outside the selected environment origin');
  return url;
}
export async function workflowHttpRequest(url: string, options: { method: string; headers?: Record<string, string>; body?: any; timeoutMs: number; environment?: any; signal?: AbortSignal }) {
  await validateWorkflowTarget(url, options.environment);
  const started = Date.now();
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs)]) : AbortSignal.timeout(options.timeoutMs);
  const response = await safeFetch(url, { method: options.method, headers: options.headers,
    ...(options.body !== undefined && !['GET', 'HEAD'].includes(options.method) ? { body: typeof options.body === 'string' ? options.body : JSON.stringify(options.body) } : {}), signal },
    { allowHttp: true, allowPrivateHosts: process.env.TM_ALLOW_PRIVATE_OUTBOUND === 'true', maxRedirects: 0 });
  const chunks: Uint8Array[] = []; let size = 0;
  if (response.body) {
    const reader = response.body.getReader();
    try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 2_000_000) { await reader.cancel(); throw new Error('Response exceeds workflow body limit'); } chunks.push(value); } }
    finally { reader.releaseLock(); }
  }
  const text = Buffer.concat(chunks).toString('utf8');
  let body: any = text; try { body = JSON.parse(text); } catch { /* retain text */ }
  return { status: response.status, headers: Object.fromEntries(response.headers), body, durationMs: Date.now() - started };
}
