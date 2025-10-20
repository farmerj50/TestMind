import { chromium } from 'playwright';
import { URL } from 'node:url';


export type FormFieldMeta = {
  name: string;
  type?: string;
  required?: boolean;
  min?: number;
  max?: number;
  pattern?: string;
};

export type FormMeta = {
  selector: string;
  action?: string;
  fields: FormFieldMeta[];
  routeHint?: string;
};

export type RouteScan = {
  url: string;
  title?: string;
  links: string[];
  buttons: string[];       // selectors for submit/buttons
  fileInputs: string[];    // names/ids of file inputs
  fields: FormFieldMeta[];
};

const ASSET_EXT = /\.(png|jpe?g|gif|svg|webp|ico|css|js|map|pdf|woff2?|ttf|eot)$/i;

function isHtmlLike(href: string) {
  if (!href) return false;
  if (ASSET_EXT.test(href)) return false;
  // keep hash-less, same-origin paths
  return true;
}

async function scanPage(url: string): Promise<RouteScan> {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded' });

  // --- everything DOM-related stays inside the browser context ---
  const info = await page.evaluate(() => {
    (globalThis as any).__name ??= (f: any) => f;
    const documentAny = (globalThis as any).document as any;
    const locationAny = (globalThis as any).location as any;
    const URLCtor = (globalThis as any).URL as any;

    const abs = (u: string) => {
      try { return new URLCtor(u, locationAny?.href).toString(); } catch { return u; }
    };
    const q = (sel: string) => Array.from(documentAny.querySelectorAll(sel) as any[]);

    const links = q('a[href]')
      .map((a: any) => a.getAttribute?.('href') || '')
      .filter(Boolean)
      .map(abs);

    const forms = q('form').map((f: any) => {
      // fields (TS-safe inside evaluate)
const fields = Array
  .from((f as any).querySelectorAll('input, select, textarea') as any[])
  .map((el: any) => {
    const name = el.getAttribute?.('name') || el.id || '';
    const type = (el.type || (el.tagName || '')).toLowerCase();
    const required = !!el.hasAttribute?.('required');
    const min = el.min ? Number(el.min) : undefined;
    const max = el.max ? Number(el.max) : undefined;
    const pattern = el.pattern || undefined;
    return { name, type, required, min, max, pattern };
  })
  .filter((ff: any) => ff.name);

// submit buttons (TS-safe inside evaluate)
const btns = Array.from(
  (f as any).querySelectorAll('button, input[type=submit], [role="button"]') as any[]
);

// normalize to Playwright-friendly selectors
const submitSelectors = btns.map((b: any) => {
  const tag = (b.tagName || '').toUpperCase();

  // inputs of type submit are unambiguous
  if (tag === 'INPUT' && (b.type || '').toLowerCase() === 'submit') {
    return 'input[type="submit"]';
  }

  // prefer text when available for buttons/role=button
  const t = (b.textContent || '').trim();
  if (t) return `button:has-text("${t}")`;

  // fallback to generic button selector
  if (tag === 'BUTTON') return 'button[type="submit"], button';

  // last resort fallback (role=button without text)
  return '[role="button"]';
});


      const id = f.id;
      const name = f.getAttribute?.('name');
      const selector = id ? `form#${id}` : (name ? `form[name="${name}"]` : 'form');

      return { selector, action: f.action || undefined, fields, submitSelectors };
    });

    const fileInputs = Array
      .from(documentAny.querySelectorAll('input[type="file"]') as any[])
      .map((el: any) => el.getAttribute?.('name') || el.id || '')
      .filter(Boolean);

    const pageButtons = Array
      .from(documentAny.querySelectorAll('button, input[type=submit]') as any[])
      .map((b: any) => {
        if ((b.tagName || '').toUpperCase() === 'INPUT') return 'input[type="submit"]';
        const t = (b.textContent || '').trim();
        return t ? `button:has-text("${t}")` : 'button';
      });

    return {
      title: String(documentAny.title || ''),
      links,
      forms,
      fileInputs,
      pageButtons,
    };
  });
  // --- end browser context ---

  await browser.close();

  // normalize links (same origin, html-like)
  const urlObj = new URL(url);
  const sameOriginLinks = info.links
    .map((href: string) => {
      try { return new URL(href, url).toString(); } catch { return ''; }
    })
    .filter(Boolean)
    .filter((h: string) => {
      try {
        const u = new URL(h);
        return u.origin === urlObj.origin && isHtmlLike(u.pathname);
      } catch {
        return false;
      }
    });

  // merge form submit selectors into "buttons" and collect fields
  const formFields: FormFieldMeta[] = [];
  const submitSelectors: string[] = [];
  for (const f of info.forms as Array<{ fields: FormFieldMeta[]; submitSelectors: string[] }>) {
    formFields.push(...f.fields);
    submitSelectors.push(...f.submitSelectors);
  }

  return {
    url,
    title: info.title || '',
    links: Array.from(new Set(sameOriginLinks)),
    buttons: Array.from(new Set([...submitSelectors, ...info.pageButtons])),
    fileInputs: Array.from(new Set(info.fileInputs)),
    fields: formFields,
  };
}


export async function discoverSite(baseUrl: string) {
  const start = new URL(baseUrl);
  // seed with home + up to 20 internal links (you can grow this / add sitemap later)
  const first = await scanPage(start.toString());

  const queue = first.links.slice(0, 20);
  const seen = new Set<string>([first.url]);
  const scans: RouteScan[] = [first];

  while (queue.length && scans.length < 40) {
    const next = queue.shift()!;
    if (seen.has(next)) continue;
    seen.add(next);

    const s = await scanPage(next);
    scans.push(s);

    // add more links from this page (breadth-first)
    for (const l of s.links) {
      if (!seen.has(l) && scans.length + queue.length < 80) queue.push(l);
    }
  }

  // also expose compact list of routes for generator
  const routes = Array.from(new Set(scans.map(s => {
    try { return new URL(s.url).pathname || '/'; } catch { return '/'; }
  })));

  return {
    routes,
    forms: [], // not needed directly anymore; we pass full scans to patterns
    apis: [],
    scans,
  };
}
