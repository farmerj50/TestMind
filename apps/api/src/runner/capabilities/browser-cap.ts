/**
 * Browser capability — HTTP-level page operations.
 *
 * Uses node fetch to retrieve pages and parse basic metadata.
 * Full Playwright execution is handled by the TestRun pipeline (worker.ts).
 *
 * Supported actions:
 *   navigate  — fetch the page, return status + title + meta tags
 *   extract   — fetch the page and return text matching a CSS selector pattern
 *               (regex-based, no DOM parser required)
 *   check     — assert a URL returns a 2xx status (health check)
 *
 * input.target = URL to fetch
 * input.params = { selector?, timeout?, headers? }
 */

import type { CapabilityInput, CapabilityOutput, ExecutionContext } from './types.js';

const DEFAULT_TIMEOUT_MS = 20_000;

async function fetchPage(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<{ status: number; body: string; ok: boolean; finalUrl: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'TestMind-Operator/1.0', ...headers },
      signal: controller.signal,
      redirect: 'follow',
    });
    const body = await res.text();
    return { status: res.status, body, ok: res.ok, finalUrl: res.url };
  } finally {
    clearTimeout(timer);
  }
}

function extractTitle(html: string): string | undefined {
  const m = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  return m ? m[1].trim() : undefined;
}

function extractMeta(html: string): Record<string, string> {
  const meta: Record<string, string> = {};
  const re = /<meta\s+(?:[^>]*?\s)?(?:name|property)="([^"]+)"[^>]*content="([^"]*)"[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    meta[m[1]] = m[2];
  }
  return meta;
}

export async function runBrowserCapability(
  input: CapabilityInput,
  ctx: ExecutionContext,
): Promise<CapabilityOutput> {
  const url = input.target ?? ctx.baseUrl;
  if (!url) return { success: false, error: 'browser capability requires a target URL' };

  const params = (input.params ?? {}) as Record<string, unknown>;
  const timeoutMs = Number(params.timeout ?? DEFAULT_TIMEOUT_MS);
  const headers = (params.headers ?? {}) as Record<string, string>;

  switch (input.action) {
    case 'navigate': {
      try {
        const page = await fetchPage(url, headers, timeoutMs);
        return {
          success: page.ok,
          data: {
            url: page.finalUrl,
            status: page.status,
            title: extractTitle(page.body),
            meta: extractMeta(page.body),
            bodyLength: page.body.length,
          },
          error: page.ok ? undefined : `HTTP ${page.status}`,
        };
      } catch (err: any) {
        return { success: false, error: err?.message ?? String(err) };
      }
    }

    case 'check': {
      try {
        const page = await fetchPage(url, headers, timeoutMs);
        return {
          success: page.ok,
          data: { url: page.finalUrl, status: page.status },
          error: page.ok ? undefined : `HTTP ${page.status}`,
        };
      } catch (err: any) {
        return { success: false, error: err?.message ?? String(err) };
      }
    }

    case 'extract': {
      const pattern = params.selector as string | undefined;
      if (!pattern) return { success: false, error: 'extract action requires params.selector (regex string)' };
      try {
        const page = await fetchPage(url, headers, timeoutMs);
        const re = new RegExp(pattern, 'gi');
        const matches: string[] = [];
        let m: RegExpExecArray | null;
        while ((m = re.exec(page.body)) !== null) {
          matches.push(m[0]);
          if (matches.length >= 50) break; // cap results
        }
        return { success: true, data: { url, status: page.status, matches } };
      } catch (err: any) {
        return { success: false, error: err?.message ?? String(err) };
      }
    }

    default:
      return { success: false, error: `Unknown browser action: ${input.action}` };
  }
}
