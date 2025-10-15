// apps/api/src/testmind/core/scanner.ts
import { globby } from 'globby';
import fs from 'fs';
import path from 'path';
import type { TestPlan } from './plan';

// ---- Config ----------------------------------------------------------------

const MAX_ROUTES = Number(process.env.TM_MAX_ROUTES || 15);

// Patterns
const urlRe = /(https?:\/\/[^\s'"`)]+)|(?<=BASE_URL=)[^\s]+/gim;
const rrRouteRe = /<Route[^>]*\spath=(?:"|')([^"']+)(?:"|')/g;          // <Route path="/foo"
const rrCreateRouterRe = /{?\s*path:\s*(?:"|')([^"']+)(?:"|')/g;        // { path: '/foo', element: ...
const linkHrefRe = /href=(?:"|')(\/[a-zA-Z0-9/_\-?=&#.%]+)(?:"|')/g;    // <a href="/foo">
const linkToRe   = /to=(?:"|')(\/[a-zA-Z0-9/_\-?=&#.%]+)(?:"|')/g;      // <Link to="/foo">

// ---- Small helpers ---------------------------------------------------------

function uniq<T>(arr: T[]) { return [...new Set(arr)]; }
function addMatches(set: Set<string>, text: string, re: RegExp) {
  for (const m of text.matchAll(re)) {
    const val = (m[1] || m[0] || '').trim();
    if (val) set.add(val);
  }
}
function safeJoin(base: string | undefined, p: string) {
  if (!base) return p;
  if (p.startsWith('http')) return p;
  return base.replace(/\/+$/,'') + (p.startsWith('/') ? p : '/'+p);
}

// Typed step builders (prevents union widening issues)
const goto = (url: string) =>
  ({ kind: 'goto', url }) as const;

const clickText = (value: string) =>
  ({ kind: 'click', by: 'text', value }) as const;

const expectText = (value: string) =>
  ({ kind: 'expectVisible', by: 'text', value }) as const;

// ---- Next.js file-based route discovery ------------------------------------

function discoverNextRoutes(repoPath: string): string[] {
  const out = new Set<string>();
  const tryDir = (rel: string) => {
    const abs = path.join(repoPath, rel);
    if (!fs.existsSync(abs)) return;
    const walk = (dir: string, prefix = '') => {
      for (const name of fs.readdirSync(dir)) {
        const p = path.join(dir, name);
        const stat = fs.statSync(p);
        if (stat.isDirectory()) {
          const seg = name.startsWith('[') ? `:${name.slice(1, -1)}` : name;
          walk(p, prefix + '/' + seg);
        } else if (/\.(tsx?|jsx?)$/.test(name)) {
          if (/^page\.(tsx?|jsx?)$/.test(name) || /^index\.(tsx?|jsx?)$/.test(name)) {
            out.add(prefix || '/');
          }
        }
      }
    };
    walk(abs, '');
  };
  tryDir('pages');
  tryDir('src/pages');
  tryDir('app');       // Next.js app dir
  tryDir('src/app');
  return [...out];
}

// ---- Main scan -------------------------------------------------------------

export async function scanRepoToPlan(repoPath: string, baseUrlInput: string): Promise<TestPlan> {
  const files = await globby(
    ['**/*.{ts,tsx,js,jsx,md,env,env.*}', '!**/node_modules/**', '!**/dist/**', '!**/.next/**', '!**/build/**'],
    { cwd: repoPath, gitignore: true }
  );

  const urls = new Set<string>();
  const paths = new Set<string>();

  for (const rel of files) {
    try {
      const text = fs.readFileSync(path.join(repoPath, rel), 'utf8');
      addMatches(urls, text, urlRe);
      addMatches(paths, text, rrRouteRe);
      addMatches(paths, text, rrCreateRouterRe);
      addMatches(paths, text, linkHrefRe);
      addMatches(paths, text, linkToRe);
    } catch { /* ignore */ }
  }

  discoverNextRoutes(repoPath).forEach(p => paths.add(p));

  const base =
    baseUrlInput ||
    [...urls].find(u => /^https?:\/\//i.test(u)) ||
    'http://localhost:3000';

  const cleaned = uniq(
    [...paths]
      .map(p => p.trim())
      .filter(p => p.startsWith('/'))
      .filter(p => !p.startsWith('/_'))
  ).slice(0, MAX_ROUTES);

  const crawlEnabled = process.env.TM_ENABLE_CRAWL === '1';
  if (crawlEnabled) {
    try {
      const crawled = await crawlBaseUrl(base);
      crawled.forEach(p => paths.add(p));
    } catch { /* non-fatal */ }
  }

  // --- Build test cases with strict step objects ---------------------------
  const routeCases = cleaned.map((p, i) => ({
    id: `route_${i}`,
    title: `Route ${p} loads`,
    steps: [
      goto(safeJoin(base, p)),
      expectText('Sign'), // heuristic, cheap sanity check
    ],
  }));

  const cases = [
    {
      id: 'smoke',
      title: 'Smoke – home loads',
      steps: [
        goto(base),
        expectText('Sign in'),
        expectText('Dashboard'),
      ],
    },
    {
      id: 'cta',
      title: 'Primary CTAs',
      steps: [
        goto(base),
        clickText('Get started'),
        clickText('Sign in'),
        clickText('Sign up'),
      ],
    },
    ...routeCases,
  ] as const;

  return {
    baseUrl: base,
    targets: [{ name: 'base', url: base }],
    cases: cases as unknown as TestPlan['cases'], // keep TS happy across repos
    meta: {
      guessedUrls: [...urls].slice(0, 10),
      discoveredPaths: cleaned,
      strategy: 'code+env+routes+links' + (crawlEnabled ? '+crawl' : ''),
    },
  };
}

// ---- Optional crawl (safe for Node typing) ---------------------------------

// ---- Optional crawl (safe for Node typing) -------------------------------
async function crawlBaseUrl(baseUrl: string): Promise<string[]> {
  // Try to get a chromium launcher from either package, but don't require it.
  let chromium: any;
  try {
    // optional dependency; avoid TS2307 when not installed
    // @ts-ignore
    ({ chromium } = await import('playwright'));
  } catch {
    try {
      // fallback if only @playwright/test is present
      // @ts-ignore
      ({ chromium } = await import('@playwright/test'));
    } catch {
      return []; // no crawler available -> just skip gracefully
    }
  }

  let browser: any;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });

    // collect same-origin links (paths) from the landing page
    const hrefs: string[] = await page.$$eval('a[href^="/"]', (as: any[]) =>
      as
        .map((a: any) => (a?.getAttribute ? a.getAttribute('href') : ''))
        .filter(Boolean)
        .map((h: string) => h.split('#')[0])
    );

    const unique = Array.from(new Set(hrefs));
    const origin = new URL(baseUrl).origin;
    const MAX = Number(process.env.TM_MAX_ROUTES ?? 15);

    // normalize relative paths to absolute URLs and cap the list
    return unique
      .slice(0, MAX)
      .map((p) => (p.startsWith('http') ? p : origin + p));
  } catch {
    return []; // any crawling failure -> just skip
  } finally {
    try { await browser?.close(); } catch {}
  }
}

