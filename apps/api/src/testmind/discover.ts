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
  return true;
}

async function scanPage(url: string): Promise<RouteScan> {
  const browser = await chromium.launch(); // headless by default
  const page = await browser.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(800);

    // 1) IN BROWSER: collect raw DOM info
    const info = await page.evaluate(() => {
      (globalThis as any).__name ??= (f: any) => f;
      const d: any = (globalThis as any).document;
      const loc: any = (globalThis as any).location;
      const URLCtor: any = (globalThis as any).URL;

      const q = (sel: string) => Array.from(d.querySelectorAll(sel) as any[]);

      // links (& link-likes)
      const abs = (u: string) => { try { return new URLCtor(u, loc?.href).toString(); } catch { return u; } };
      const aHrefs      = q('a[href]').map((a: any) => a.getAttribute?.('href') || '').filter(Boolean);
      const roleLinks   = q('[role="link"]').map((el: any) => el.getAttribute?.('href') || el.getAttribute?.('data-href') || '').filter(Boolean);
      const dataHref    = q('[data-href], [data-route]').map((el: any) => el.getAttribute?.('data-href') || el.getAttribute?.('data-route') || '').filter(Boolean);
      const onclickCode = q('[onclick]')
        .map((el: any) => String(el.getAttribute?.('onclick') || ''))
        .filter((code: string) =>
          /location\.href\s*=|window\.location\s*=|window\.location\.(assign|replace)/.test(code)
        )
        .map((code: string) => {
          const m = code.match(/['"]\/[^'"]+['"]/);
          return m ? m[0].slice(1, -1) : '';
        })
        .filter(Boolean);

      const links = [...aHrefs, ...roleLinks, ...dataHref, ...onclickCode].map(abs);

      // forms
      const forms = q('form').map((f: any) => {
        const fields = Array.from((f as any).querySelectorAll('input, select, textarea') as any[])
          .map((el: any) => {
            const type = (el.type || (el.tagName || '')).toLowerCase();
            const name = el.getAttribute?.('name') || el.id || el.getAttribute?.('aria-label') || el.getAttribute?.('placeholder') || '';
            if (!name) return null;
            const required = !!el.hasAttribute?.('required');
            const min = el.min ? Number(el.min) : undefined;
            const max = el.max ? Number(el.max) : undefined;
            const pattern = el.pattern || undefined;
            return { name, type, required, min, max, pattern };
          })
          .filter(Boolean);

        const btns = Array.from((f as any).querySelectorAll('button, input[type=submit], [role="button"]') as any[]);
        const submitSelectors = btns.map((b: any) => {
          const tag = (b.tagName || '').toUpperCase();
          if (tag === 'INPUT' && (b.type || '').toLowerCase() === 'submit') return 'input[type="submit"]';
          const t = (b.textContent || '').trim();
          if (t) return `button:has-text("${t}")`;
          if (tag === 'BUTTON') return 'button[type="submit"], button';
          return '[role="button"]';
        });

        const id = f.id;
        const name = f.getAttribute?.('name');
        const selector = id ? `form#${id}` : (name ? `form[name="${name}"]` : 'form');
        return { selector, action: f.action || undefined, fields, submitSelectors };
      });

      // page-level fields (outside forms)
      const pageLevelFields = q('input, select, textarea')
        .map((el: any) => {
          const type = (el.type || (el.tagName || '')).toLowerCase();
          if (['submit', 'button', 'reset', 'hidden', 'file'].includes(type)) return null;
          const name = el.getAttribute?.('name') || el.id || el.getAttribute?.('aria-label') || el.getAttribute?.('placeholder') || '';
          if (!name) return null;
          const required = !!el.hasAttribute?.('required');
          const min = el.min ? Number(el.min) : undefined;
          const max = el.max ? Number(el.max) : undefined;
          const pattern = el.pattern || undefined;
          return { name, type, required, min, max, pattern };
        })
        .filter(Boolean);

      const fileInputs = q('input[type="file"]').map((el: any) => el.getAttribute?.('name') || el.id || '').filter(Boolean);

      const pageButtons = q('button, input[type=submit]').map((b: any) => {
        if ((b.tagName || '').toUpperCase() === 'INPUT') return 'input[type="submit"]';
        const t = (b.textContent || '').trim();
        return t ? `button:has-text("${t}")` : 'button';
      });

      return {
        title: String(d.title || ''),
        links,
        forms,
        fileInputs,
        pageButtons,
        mergedFields: pageLevelFields,
      };
    });

    // 2) OUTSIDE BROWSER: normalize & merge
    const urlObj = new URL(url);
    const sameOriginLinks = info.links
      .map((href: string) => { try { return new URL(href, url).toString(); } catch { return ''; } })
      .filter(Boolean)
      .filter((h: string) => { try { const u = new URL(h); return u.origin === urlObj.origin && isHtmlLike(u.pathname); } catch { return false; } });

    const formFields: FormFieldMeta[] = [];
    const submitSelectors: string[] = [];
    for (const f of info.forms as Array<{ fields: FormFieldMeta[]; submitSelectors: string[] }>) {
      formFields.push(...f.fields);
      submitSelectors.push(...f.submitSelectors);
    }
    const pageFields: FormFieldMeta[] = Array.isArray((info as any).mergedFields) ? (info as any).mergedFields : [];

    return {
      url,
      title: info.title || '',
      links: Array.from(new Set(sameOriginLinks)),
      buttons: Array.from(new Set([...submitSelectors, ...info.pageButtons])),
      fileInputs: Array.from(new Set(info.fileInputs)),
      fields: [...formFields, ...pageFields],
    };
  } finally {
    await browser.close();
  }
}

// discover.ts
export async function discoverSite(baseUrl: string, seedRoutes: string[] = []) {
  const start = new URL(baseUrl);
  const first = await scanPage(start.toString());

  const MAX = Number(process.env.TM_MAX_ROUTES || 150);

  // seed with: (1) links from home, (2) repo-discovered routes
  const seeded = [
    ...first.links,
    ...seedRoutes.map(r => new URL(r, baseUrl).toString()),
  ];

  const queue = Array.from(new Set(seeded)).slice(0, MAX);
  const seen = new Set<string>([first.url]);
  const scans: RouteScan[] = [first];

  while (queue.length && scans.length < MAX) {
    const next = queue.shift()!;
    if (seen.has(next)) continue;
    seen.add(next);

    const s = await scanPage(next);
    scans.push(s);

    // keep exploring newly found links
    for (const l of s.links) {
      if (!seen.has(l) && scans.length + queue.length < MAX) queue.push(l);
    }
  }
  

  // routes list for plan labeling
  const routes = Array.from(new Set(scans.map(s => {
    try { return new URL(s.url).pathname || '/'; } catch { return '/'; }
  })));

  // ✅ Build `forms` from each scan so the plan can emit validation/submit tests
  const forms: FormMeta[] = scans.flatMap(scan => {
    const pathname = (() => { try { return new URL(scan.url).pathname || "/"; } catch { return "/"; } })();
    if (!scan.fields?.length) return [];
    return [{
      selector: "form",
      action: undefined,
      fields: scan.fields.map(f => ({
        name: f.name,
        type: f.type,
        required: f.required,
        min: f.min,
        max: f.max,
        pattern: f.pattern
      })),
      routeHint: pathname
    }];
  });
  

  return {
    routes,
    forms,   // ← return the synthesized forms (was [] before)
    apis: [],
    scans,
  };
}
