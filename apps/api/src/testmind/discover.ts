// apps/api/src/testmind/discover.ts
import type { Discovery, FormMeta, FormFieldMeta } from './core/plan.js';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow' as any });
  if (!res.ok) throw new Error(`fetch ${url} ${res.status}`);
  return await res.text();
}

function absolutize(base: string, href: string): string | null {
  try {
    const u = new URL(href, base);
    const origin = new URL(base).origin;
    return u.origin === origin ? u.toString() : null;
  } catch { return null; }
}

function pathnameOf(u: string): string {
  try { return new URL(u).pathname || '/'; } catch { return '/'; }
}

function dedupePaths(urls: string[]): string[] {
  const seen = new Set<string>();
  for (const u of urls) {
    const p = pathnameOf(u).replace(/\/+$/, '') || '/';
    seen.add(p || '/');
  }
  return Array.from(seen);
}

/** Parse a very common subset of sitemap.xml into URLs */
async function fetchSitemapUrls(baseUrl: string, cap = 500): Promise<string[]> {
  const origin = new URL(baseUrl).origin;
  const candidates = [
    new URL('/sitemap.xml', origin).toString(),
    new URL('/sitemap_index.xml', origin).toString(),
  ];

  const urls: string[] = [];
  for (const s of candidates) {
    try {
      const xml = await fetchText(s);
      // <loc>https://example.com/path</loc>
      const rx = /<loc>\s*([^<]+)\s*<\/loc>/gi;
      let m: RegExpExecArray | null;
      while ((m = rx.exec(xml))) {
        const abs = absolutize(baseUrl, m[1].trim());
        if (abs) urls.push(abs);
        if (urls.length >= cap) break;
      }
      if (urls.length) break; // first successful sitemap is enough
    } catch { /* ignore */ }
  }
  return urls.slice(0, cap);
}

/** Pragmatic form extractor (same as before) */
function extractForms(html: string, routePath: string): FormMeta[] {
  const out: FormMeta[] = [];
  const formRx = /<form\b[^>]*>([\s\S]*?)<\/form>/gi;
  let m: RegExpExecArray | null;
  while ((m = formRx.exec(html))) {
    const inner = m[1] || '';
    const fields: FormFieldMeta[] = [];
    const fieldRx = /<(input|textarea|select)\b[^>]*>/gi;
    let f: RegExpExecArray | null;
    while ((f = fieldRx.exec(inner))) {
      const tag = f[0];
      const get = (n: string) => {
        const a = new RegExp(`${n}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
        return a ? (a[2] ?? a[3] ?? a[4] ?? '').trim() : '';
      };
      const name =
        get('name') || get('id') || get('aria-label') || get('placeholder');
      if (!name) continue;
      const type = (get('type') ||
        (tag.toLowerCase().startsWith('<textarea') ? 'textarea' :
         tag.toLowerCase().startsWith('<select') ? 'select' : 'text')).toLowerCase();
      const required = /\brequired\b/i.test(tag);
      fields.push({ name, type, required });
    }
    if (fields.length) {
      out.push({ selector: 'form', action: '', fields, routeHint: routePath });
    }
  }
  return out;
}

/** Fast static BFS */
async function crawlStatic(baseUrl: string, maxPages: number): Promise<string[]> {
  const seen = new Set<string>();
  const q: string[] = [baseUrl];
  while (q.length && seen.size < maxPages) {
    const url = q.shift()!;
    if (seen.has(url)) continue;
    seen.add(url);
    let html = '';
    try { html = await fetchText(url); } catch { continue; }
    const rx = /href\s*=\s*(?:"([^"]+)"|'([^']+)'|([^>\s]+))/gi;
    let m: RegExpExecArray | null;
    while ((m = rx.exec(html))) {
      const href = (m[1] || m[2] || m[3] || '').trim();
      if (!href) continue;
      const abs = absolutize(baseUrl, href);
      if (abs && !seen.has(abs)) q.push(abs);
    }
  }
  return Array.from(seen);
}

/** Add obvious seeds when we discovered too few pages */
function seedIfThin(baseUrl: string, paths: string[], min = 30): string[] {
  if (paths.length >= min) return paths;
  const origin = new URL(baseUrl).origin;
  const seeds = [
    '/', '/about', '/contact', '/pricing', '/faq', '/blog', '/posts',
    '/news', '/careers', '/privacy', '/terms', '/login', '/signup',
    '/services', '/service', '/team',
  ];
  const merged = new Set(paths);
  for (const p of seeds) merged.add(new URL(p, origin).toString());
  return Array.from(merged);
}

export async function discoverSite(baseUrl: string): Promise<Discovery> {
  const MAX = Number(process.env.TM_MAX_ROUTES ?? 200);

  // 1) Sitemap URLs (fast, often big)
  const fromSitemap = await fetchSitemapUrls(baseUrl, MAX);

  // 2) Static BFS
  const fromStatic = await crawlStatic(baseUrl, MAX);

  // 3) Merge + dedupe (same-origin, path-normalized)
  const all = dedupePaths([...fromSitemap, ...fromStatic].map(u => absolutize(baseUrl, u) || u));
  const seeded = seedIfThin(baseUrl, all, 30); // ensure we have at least ~30 paths

  // 4) Pull basic forms from the first chunk
  const FORM_SCAN_MAX = 60;
  const forms: FormMeta[] = [];
  for (const p of seeded.slice(0, FORM_SCAN_MAX)) {
    const url = new URL(p, baseUrl).toString();
    try {
      const html = await fetchText(url);
      forms.push(...extractForms(html, p));
    } catch { /* ignore */ }
  }

  return { routes: seeded, forms, apis: [] };
}
