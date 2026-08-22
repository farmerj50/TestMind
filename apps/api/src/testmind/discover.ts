import { chromium, type BrowserContext, type Page } from 'playwright';
import { URL } from 'node:url';
import { semanticKeyFromString } from './runtime/locator-store.js';
import { rankAuthEntryCandidates, type AuthEntryCandidate } from '../lib/auth-entry-confidence.js';

export type AuthCredentials = { username: string; password: string; otp?: string };
export type LoginOutcome = 'success' | 'failed' | 'not_needed';

// Distinguishes *why* an auth attempt didn't reach 'success', so the caller can
// show an accurate message instead of a blanket "credentials were rejected" —
// which is wrong when credentials were never actually submitted anywhere.
export type AuthFailureReason =
  | 'AUTH_ENTRY_NOT_FOUND' // no Sign In / Log In control could be found at all
  | 'LOGIN_FORM_NOT_FOUND' // an entry point was clicked, but no credential form ever appeared
  | 'CREDENTIALS_REJECTED' // a form was found, filled, and submitted, but login didn't succeed
  | 'MFA_REQUIRED'         // an OTP/verification step appeared and no code was supplied
  | 'AUTH_TIMEOUT';        // the whole auth flow exceeded its time budget

export type AuthScanResult = RouteScan & {
  loginOutcome: LoginOutcome;
  authFailureReason?: AuthFailureReason;
  authEntryUsed?: string;
  authTransitions?: number;
};

export type FormFieldMeta = {
  name: string;
  type?: string;
  required?: boolean;
  min?: number;
  max?: number;
  pattern?: string;
  label?: string;
  placeholder?: string;
  selector?: string;
  options?: string[];
};

export type FormMeta = {
  selector: string;
  action?: string;
  fields: FormFieldMeta[];
  routeHint?: string;
};

export type RouteScanForm = {
  selector: string;
  action?: string;
  fields: FormFieldMeta[];
  submitSelectors: string[];
};

export type ControlMeta = {
  label: string;
  selector: string;
  tag?: string;
  role?: string;
  type?: string;
  href?: string;
  ariaLabel?: string;
  testId?: string;
  disabled?: boolean;
};

export type RouteScan = {
  url: string;
  finalUrl?: string;
  title?: string;
  status: number;
  links: string[];
  buttons: string[];
  fileInputs: string[];
  fields: FormFieldMeta[];
  forms?: RouteScanForm[];
  controls?: ControlMeta[];
  headings?: string[];
  textSnippets?: string[];
};

export type RouteDiscoveryHint = {
  routes: string[];
  selectors: string[];
  coverageGoals?: string[];
  rationale?: string[];
};

export type RouteDiscoveryAdvisor = (input: {
  baseUrl: string;
  currentScan: RouteScan;
  scans: RouteScan[];
  remainingPages: number;
}) => Promise<RouteDiscoveryHint>;

type DiscoveryOptions = {
  maxPages?: number;
  cookieString?: string;
  routeAdvisor?: RouteDiscoveryAdvisor;
};

const ASSET_EXT = /\.(png|jpe?g|gif|svg|webp|ico|css|js|map|pdf|woff2?|ttf|eot)$/i;
const UNSAFE_ROUTE_RE = /\/(logout|log-out|signout|sign-out|delete|destroy|remove)(?:\/|$|\?)/i;
const NON_NAV_CONTROL_RE = /\b(submit|save|delete|remove|logout|log out|signout|sign out|upload|download|pay|purchase|checkout|send|post|confirm|cancel|close|sign in|signin|log in|login|create account|get started|emergency)\b/i;
const MAX_CLICK_ROUTE_DISCOVERY_PER_PAGE = 20;
const MAX_AI_ROUTE_DISCOVERY_CALLS = 8;

function isHtmlLike(href: string) {
  if (!href) return false;
  if (ASSET_EXT.test(href)) return false;
  return true;
}

function effectiveScanUrl(scan: RouteScan): string {
  return scan.finalUrl || scan.url;
}

function safePathFromUrl(raw: string, base?: string): string {
  try {
    return new URL(raw, base).pathname || '/';
  } catch {
    return raw.startsWith('/') ? raw : '/';
  }
}

function normalizeCrawlUrl(raw: string, baseUrl: string): string | null {
  try {
    const base = new URL(baseUrl);
    const url = new URL(raw, base);
    if (url.origin !== base.origin) return null;
    if (!isHtmlLike(url.pathname)) return null;
    if (UNSAFE_ROUTE_RE.test(url.pathname)) return null;
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

function parseCookieString(cookieStr: string, pageUrl: string) {
  // Use url (not domain) so Playwright resolves domain/secure flags automatically
  return cookieStr
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((pair) => {
      const eqIdx = pair.indexOf('=');
      if (eqIdx === -1) return null;
      return {
        name: pair.slice(0, eqIdx).trim(),
        value: pair.slice(eqIdx + 1).trim(),
        url: pageUrl,
      };
    })
    .filter((c): c is NonNullable<typeof c> => c !== null);
}

// ── Core DOM extraction (reused by scanPage and authenticated scan) ───────────

async function extractRouteScan(page: Page, url: string, status: number): Promise<RouteScan> {
  const finalUrl = page.url();

  const info = await page.evaluate(() => {
    // Guard against esbuild's __name helper not being present in the browser sandbox.
    // new Function avoids esbuild wrapping the RHS with __name() (which would be circular).
    if (!(globalThis as any).__name) {
      (globalThis as any).__name = new Function('f', 'return f') as any;
    }
    const d: any = (globalThis as any).document;
    const loc: any = (globalThis as any).location;
    const URLCtor: any = (globalThis as any).URL;

    const q = (sel: string) => Array.from(d.querySelectorAll(sel) as any[]);
    const compactText = (value: any, max = 120) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
    const quote = (value: any) => String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const cssEscape = (value: any) => {
      const raw = String(value || '');
      const css = (globalThis as any).CSS;
      if (css?.escape) return css.escape(raw);
      return raw.replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`);
    };
    const isVisible = (el: any) => {
      const rect = el.getBoundingClientRect?.();
      const style = (globalThis as any).getComputedStyle?.(el);
      return !!rect
        && rect.width > 0
        && rect.height > 0
        && style?.display !== 'none'
        && style?.visibility !== 'hidden'
        && style?.opacity !== '0';
    };
    const labelFor = (el: any) => {
      const id = el.id || el.getAttribute?.('id');
      if (id) {
        const explicit = d.querySelector(`label[for="${quote(id)}"]`);
        const text = compactText(explicit?.textContent);
        if (text) return text;
      }
      const wrapped = el.closest?.('label');
      const wrappedText = compactText(wrapped?.textContent);
      if (wrappedText) return wrappedText;
      return compactText(
        el.getAttribute?.('aria-label')
        || el.getAttribute?.('placeholder')
        || el.getAttribute?.('name')
        || el.id
      );
    };
    const fieldSelector = (el: any) => {
      const testId = el.getAttribute?.('data-testid');
      if (testId) return `[data-testid="${quote(testId)}"]`;
      const name = el.getAttribute?.('name');
      if (name) return `[name="${quote(name)}"]`;
      if (el.id) return `#${cssEscape(el.id)}`;
      const aria = el.getAttribute?.('aria-label');
      if (aria) return `[aria-label="${quote(aria)}"]`;
      const placeholder = el.getAttribute?.('placeholder');
      if (placeholder) return `[placeholder="${quote(placeholder)}"]`;
      return (el.tagName || 'input').toLowerCase();
    };
    const controlSelector = (el: any) => {
      const tag = (el.tagName || '').toLowerCase();
      const type = (el.getAttribute?.('type') || el.type || '').toLowerCase();
      const role = el.getAttribute?.('role');
      const testId = el.getAttribute?.('data-testid');
      const aria = el.getAttribute?.('aria-label');
      const text = compactText(el.textContent || el.getAttribute?.('value') || aria || testId);
      if (testId) return `[data-testid="${quote(testId)}"]`;
      if (el.id) return `#${cssEscape(el.id)}`;
      if (tag === 'a') {
        const href = el.getAttribute?.('href');
        if (href) return `a[href="${quote(href)}"]`;
        if (text) return `a:has-text("${quote(text)}")`;
        return 'a';
      }
      if (tag === 'button') return text ? `button:has-text("${quote(text)}")` : 'button';
      if (tag === 'input' && ['submit', 'button', 'reset'].includes(type)) {
        return type ? `input[type="${quote(type)}"]` : 'input';
      }
      if (role && text) return `[role="${quote(role)}"]:has-text("${quote(text)}")`;
      if (role) return `[role="${quote(role)}"]`;
      if (aria) return `[aria-label="${quote(aria)}"]`;
      if (text) return `[tabindex="0"]:has-text("${quote(text)}")`;
      return `[tabindex="0"]`;
    };
    const fieldMeta = (el: any) => {
      const type = (el.type || (el.tagName || '')).toLowerCase();
      const name = el.getAttribute?.('name') || el.id || el.getAttribute?.('aria-label') || el.getAttribute?.('placeholder') || '';
      const label = labelFor(el);
      if (!name && !label) return null;
      const options = Array.from(el.querySelectorAll?.('option') || [])
        .map((opt: any) => compactText(opt.textContent || opt.getAttribute?.('value'), 80))
        .filter(Boolean)
        .slice(0, 25);
      const required = !!el.hasAttribute?.('required') || el.getAttribute?.('aria-required') === 'true';
      const min = el.min ? Number(el.min) : undefined;
      const max = el.max ? Number(el.max) : undefined;
      const pattern = el.pattern || undefined;
      return {
        name: name || label,
        type,
        required,
        min: Number.isFinite(min) ? min : undefined,
        max: Number.isFinite(max) ? max : undefined,
        pattern,
        label,
        placeholder: el.getAttribute?.('placeholder') || undefined,
        selector: fieldSelector(el),
        options,
      };
    };

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

    const forms = q('form').map((f: any) => {
      const fields = Array.from((f as any).querySelectorAll('input, select, textarea') as any[])
        .map((el: any) => fieldMeta(el))
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

    const pageLevelFields = q('input, select, textarea')
      .map((el: any) => {
        const type = (el.type || (el.tagName || '')).toLowerCase();
        if (['submit', 'button', 'reset', 'hidden', 'file'].includes(type)) return null;
        return fieldMeta(el);
      })
      .filter(Boolean);

    const fileInputs = q('input[type="file"]').map((el: any) => el.getAttribute?.('name') || el.id || '').filter(Boolean);

    const pageButtons = q('button, input[type=submit]').map((b: any) => {
      if ((b.tagName || '').toUpperCase() === 'INPUT') return 'input[type="submit"]';
      const t = (b.textContent || '').trim();
      return t ? `button:has-text("${t}")` : 'button';
    });

    const controlSelectorQuery = [
      'a[href]',
      'button',
      'input[type=button]',
      'input[type=submit]',
      'input[type=reset]',
      '[role="button"]',
      '[role="link"]',
      '[role="tab"]',
      '[role="menuitem"]',
      '[role="switch"]',
      '[role="checkbox"]',
      '[role="radio"]',
      '[role="combobox"]',
      '[tabindex="0"]',
      'summary',
      '[data-testid]',
    ].join(',');

    const controls = q(controlSelectorQuery)
      .filter((el: any) => isVisible(el))
      .map((el: any) => {
        const tag = (el.tagName || '').toLowerCase();
        const type = (el.getAttribute?.('type') || el.type || '').toLowerCase();
        if (tag === 'input' && !['button', 'submit', 'reset', 'checkbox', 'radio'].includes(type)) return null;
        const role = el.getAttribute?.('role') || undefined;
        const ariaLabel = el.getAttribute?.('aria-label') || undefined;
        const testId = el.getAttribute?.('data-testid') || undefined;
        const href = el.getAttribute?.('href') || el.getAttribute?.('data-href') || el.getAttribute?.('data-route') || undefined;
        const label = compactText(el.textContent || el.getAttribute?.('value') || ariaLabel || testId || href, 120);
        const selector = controlSelector(el);
        if (!selector) return null;
        return {
          label: label || selector,
          selector,
          tag,
          role,
          type,
          href: href ? abs(href) : undefined,
          ariaLabel,
          testId,
          disabled: !!el.disabled || el.getAttribute?.('aria-disabled') === 'true',
        };
      })
      .filter(Boolean);

    const headings = q('h1, h2, [role="heading"]')
      .filter((el: any) => isVisible(el))
      .map((el: any) => compactText(el.textContent, 120))
      .filter(Boolean)
      .slice(0, 12);

    const textSnippets = q('main, [role="main"], body')
      .slice(0, 2)
      .map((el: any) => compactText(el.innerText || el.textContent, 500))
      .filter(Boolean);

    return { title: String(d.title || ''), links, forms, fileInputs, pageButtons, mergedFields: pageLevelFields, controls, headings, textSnippets };
  });

  const urlObj = new URL(url);
  const sameOriginLinks = info.links
    .map((href: string) => { try { return new URL(href, url).toString(); } catch { return ''; } })
    .filter(Boolean)
    .filter((h: string) => {
      try { const u = new URL(h); return u.origin === urlObj.origin && isHtmlLike(u.pathname); } catch { return false; }
    });

  const formFields: FormFieldMeta[] = [];
  const submitSelectors: string[] = [];
  for (const f of info.forms as Array<{ fields: FormFieldMeta[]; submitSelectors: string[] }>) {
    formFields.push(...f.fields);
    submitSelectors.push(...f.submitSelectors);
  }
  const pageFields: FormFieldMeta[] = Array.isArray((info as any).mergedFields) ? (info as any).mergedFields : [];
  const controls: ControlMeta[] = Array.isArray((info as any).controls) ? (info as any).controls : [];
  const fieldSeen = new Set<string>();
  const fields = [...formFields, ...pageFields].filter((field) => {
    const key = `${field.selector ?? ''}|${field.name}|${field.type ?? ''}`;
    if (fieldSeen.has(key)) return false;
    fieldSeen.add(key);
    return true;
  });

  return {
    url,
    finalUrl: finalUrl !== url ? finalUrl : undefined,
    status,
    title: info.title || '',
    links: Array.from(new Set(sameOriginLinks)),
    buttons: Array.from(new Set([...submitSelectors, ...info.pageButtons, ...controls.map((c) => c.selector)])),
    fileInputs: Array.from(new Set(info.fileInputs)),
    fields,
    forms: (info.forms as Array<{ selector: string; action?: string; fields: FormFieldMeta[]; submitSelectors: string[] }>).map(f => ({
      selector: f.selector,
      action: f.action,
      fields: f.fields,
      submitSelectors: f.submitSelectors,
    })),
    controls,
    headings: Array.isArray((info as any).headings) ? (info as any).headings : [],
    textSnippets: Array.isArray((info as any).textSnippets) ? (info as any).textSnippets : [],
  };
}

async function scanUrlOnPage(page: Page, url: string): Promise<RouteScan> {
  const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  const status = response?.status() ?? 0;
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(800);
  return await extractRouteScan(page, url, status);
}

function isSafeRouteDiscoveryControl(control: ControlMeta): boolean {
  if (control.disabled || control.href) return false;

  const label = (control.label || control.ariaLabel || control.testId || '').trim();
  if (!label || label.length > 80) return false;

  const tag = (control.tag || '').toLowerCase();
  const role = (control.role || '').toLowerCase();
  const selector = control.selector || '';
  const signal = `${label} ${control.ariaLabel || ''} ${control.testId || ''} ${selector}`;
  if (NON_NAV_CONTROL_RE.test(signal)) return false;
  if (tag === 'input') return false;
  if (['switch', 'checkbox', 'radio', 'combobox'].includes(role)) return false;

  return true;
}

function isLikelyRouteDiscoveryControl(control: ControlMeta): boolean {
  if (!isSafeRouteDiscoveryControl(control)) return false;

  const tag = (control.tag || '').toLowerCase();
  const role = (control.role || '').toLowerCase();
  const selector = control.selector || '';

  return tag === 'a'
    || role === 'link'
    || role === 'tab'
    || role === 'menuitem'
    || selector.includes('[tabindex="0"]')
    || /\b(nav|menu|tab|route|link|item)\b/i.test(control.testId || '');
}

async function restorePageForRouteDiscovery(page: Page, url: string): Promise<void> {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
    await page.waitForTimeout(250);
  } catch {
    // The main crawl path will report unreachable pages; click discovery just
    // skips controls that cannot be restored safely.
  }
}

async function discoverRoutesByClickingControls(
  page: Page,
  scan: RouteScan,
  baseUrl: string,
  remainingSlots: number,
  preferredSelectors: string[] = [],
): Promise<string[]> {
  if (remainingSlots <= 0) return [];

  const sourceUrl = effectiveScanUrl(scan);
  const sourceNorm = normalizeCrawlUrl(sourceUrl, baseUrl);
  const preferred = new Set(preferredSelectors);
  const candidates = (scan.controls ?? [])
    .filter((control) =>
      preferred.has(control.selector)
        ? isSafeRouteDiscoveryControl(control)
        : isLikelyRouteDiscoveryControl(control)
    )
    .sort((a, b) => Number(preferred.has(b.selector)) - Number(preferred.has(a.selector)))
    .slice(0, Math.min(MAX_CLICK_ROUTE_DISCOVERY_PER_PAGE, remainingSlots));
  const discovered = new Set<string>();

  for (const control of candidates) {
    if (discovered.size >= remainingSlots) break;

    await restorePageForRouteDiscovery(page, sourceUrl);
    const before = normalizeCrawlUrl(page.url(), baseUrl) ?? sourceNorm;

    try {
      const popupPromise = page.context().waitForEvent('page', { timeout: 800 }).catch(() => null);
      await page.locator(control.selector).first().click({ timeout: 1_500 });
      await page.waitForLoadState('domcontentloaded', { timeout: 2_000 }).catch(() => {});
      await page.waitForLoadState('networkidle', { timeout: 2_000 }).catch(() => {});
      await page.waitForTimeout(250);

      const popup = await popupPromise;
      const targetPage = popup ?? page;
      if (popup) {
        await popup.waitForLoadState('domcontentloaded', { timeout: 2_000 }).catch(() => {});
        await popup.waitForLoadState('networkidle', { timeout: 2_000 }).catch(() => {});
      }

      const targetUrl = normalizeCrawlUrl(targetPage.url(), baseUrl);
      if (targetUrl && targetUrl !== before) {
        discovered.add(targetUrl);
      }

      const transientScan = await extractRouteScan(targetPage, targetPage.url(), 200).catch(() => null);
      for (const route of [
        ...(transientScan?.links ?? []),
        ...((transientScan?.controls ?? []).map((c) => c.href).filter(Boolean) as string[]),
      ]) {
        const normalized = normalizeCrawlUrl(route, baseUrl);
        if (normalized && normalized !== before) discovered.add(normalized);
        if (discovered.size >= remainingSlots) break;
      }

      if (popup) await popup.close().catch(() => {});
    } catch {
      // Some controls are hover-only, hidden under overlays, or intentionally
      // stateful. Route discovery should remain best-effort and non-fatal.
    }
  }

  await restorePageForRouteDiscovery(page, sourceUrl);
  return Array.from(discovered).slice(0, remainingSlots);
}

export async function scanPage(url: string, sharedCtx?: BrowserContext): Promise<RouteScan> {
  const ownBrowser = !sharedCtx;
  const browser = ownBrowser ? await chromium.launch() : null;
  const context = sharedCtx ?? (await browser!.newContext());
  const page = await context.newPage();

  try {
    return await scanUrlOnPage(page, url);
  } finally {
    await page.close();
    if (ownBrowser) {
      await context.close();
      await browser!.close();
    }
  }
}

// ── Authenticated scan helpers ────────────────────────────────────────────────

// Tried in priority order, most-specific/reliable first. Framework-rendered
// apps (React Native Web/Expo, etc.) often submit via a bare <div tabindex="0">
// with no semantic tag — data-testid/aria-label are the only real signal there.
// A broad ":has-text()" pass is last and lowest-priority since it risks
// matching an unrelated same-page control (e.g. a "Sign In" vs "Create
// Account" mode-toggle tab that happens to sit earlier in the DOM).
const SUBMIT_BUTTON_SELECTORS = [
  'button[type="submit"]',
  'input[type="submit"]',
  '[data-testid*="submit" i]',
  '[aria-label*="submit" i]',
  '[data-testid*="sign-in" i]',
  '[data-testid*="signin" i]',
  '[data-testid*="login" i]',
  '[aria-label*="sign in" i]',
  '[aria-label*="log in" i]',
  'button:has-text("Sign in")',
  'button:has-text("Log in")',
  'button:has-text("Login")',
  'button:has-text("Continue")',
  'button:has-text("Next")',
];

async function findSubmitButton(page: Page) {
  for (const selector of SUBMIT_BUTTON_SELECTORS) {
    const el = await page.$(selector);
    if (el) return el;
  }
  return null;
}

async function fillLoginForm(page: Page, creds: AuthCredentials): Promise<boolean> {
  const usernameField = await page.$(
    'input[type="email"], input[name="email"], input[name="username"], input[name="login"], input[name="user"], input[id*="email" i], input[id*="username" i], input[placeholder*="email" i], input[placeholder*="username" i]'
  );
  const passwordField = await page.$('input[type="password"]');
  if (!usernameField || !passwordField) return false;

  await usernameField.fill(creds.username);
  await passwordField.fill(creds.password);

  const submitBtn = await findSubmitButton(page);
  if (submitBtn) {
    await submitBtn.click();
  } else {
    await passwordField.press('Enter');
  }
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
  await page.waitForTimeout(500);
  return true;
}

async function fillOtpForm(page: Page, otp: string): Promise<boolean> {
  const otpField = await page.$(
    'input[autocomplete="one-time-code"], input[inputmode="numeric"][maxlength="6"], input[name="otp"], input[name="code"], input[name="token"], input[placeholder*="code" i], input[aria-label*="code" i], input[aria-label*="otp" i], input[aria-label*="verification" i]'
  );
  if (!otpField) return false;
  await otpField.fill(otp);
  const submitBtn = await findSubmitButton(page);
  if (submitBtn) await submitBtn.click();
  else await otpField.press('Enter');
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
  await page.waitForTimeout(500);
  return true;
}

const AUTH_DISCOVERY_TIMEOUT_MS = 45_000;
const MAX_AUTH_TRANSITIONS = 3;
// Below this, a candidate is more likely nav chrome ("Learn More", "Pricing")
// than an actual sign-in control — see auth-entry-confidence.ts's scoring.
const MIN_AUTH_ENTRY_SCORE = 40;

const OTP_FIELD_SELECTOR =
  'input[autocomplete="one-time-code"], input[inputmode="numeric"][maxlength="6"], input[name="otp"], input[name="code"], input[name="token"], input[placeholder*="code" i], input[aria-label*="code" i], input[aria-label*="otp" i], input[aria-label*="verification" i]';

async function hasPasswordField(page: Page): Promise<boolean> {
  return (await page.$('input[type="password"]')) !== null;
}

async function findAuthEntryCandidates(page: Page): Promise<AuthEntryCandidate[]> {
  return page.evaluate(() => {
    if (!(globalThis as any).__name) {
      (globalThis as any).__name = new Function('f', 'return f') as any;
    }
    const d: any = (globalThis as any).document;
    const q = (sel: string) => Array.from(d.querySelectorAll(sel) as any[]);
    // Traditional semantic controls and ARIA roles, plus the framework-rendered
    // "clickable div" pattern used by React Native Web / Expo apps, which emit
    // a bare <div tabindex="0"> or <div data-testid="..."> with no semantic
    // tag or role at all — a plain a/button/[role] query misses these entirely.
    const els = q('a, button, [role="button"], [role="link"], [tabindex="0"], [data-testid]');
    const seen = new Set<any>();
    const out: any[] = [];
    for (const el of els) {
      if (seen.has(el)) continue;
      seen.add(el);

      const tag = (el.tagName || '').toLowerCase();
      const text = (el.textContent || '').trim().slice(0, 80);
      const role = el.getAttribute?.('role') || undefined;
      const href = tag === 'a' ? (el.getAttribute?.('href') || undefined) : undefined;
      const ariaLabel = el.getAttribute?.('aria-label') || undefined;
      const testId = el.getAttribute?.('data-testid') || undefined;
      if (!text && !href && !ariaLabel && !testId) continue;

      let selector: string;
      if (testId) selector = `[data-testid="${testId}"]`;
      else if (tag === 'a') selector = text ? `a:has-text("${text}")` : 'a';
      else if (tag === 'button') selector = text ? `button:has-text("${text}")` : 'button';
      else if (ariaLabel) selector = `[aria-label="${ariaLabel}"]`;
      else if (role) selector = text ? `[role="${role}"]:has-text("${text}")` : `[role="${role}"]`;
      else selector = text ? `[tabindex="0"]:has-text("${text}")` : '[tabindex="0"]';

      out.push({ selector, text, tag, role, href, ariaLabel, testId });
    }
    return out;
  });
}

async function waitForPasswordField(page: Page, timeoutMs: number): Promise<boolean> {
  if (timeoutMs <= 0) return hasPasswordField(page);
  try {
    await page.waitForSelector('input[type="password"]', { timeout: timeoutMs, state: 'visible' });
    return true;
  } catch {
    return false;
  }
}

async function submitCredentials(
  page: Page,
  creds: AuthCredentials,
  context: BrowserContext,
  url: string,
  authTransitions: number,
  authEntryUsed: string | undefined
): Promise<AuthScanResult> {
  const filled = await fillLoginForm(page, creds);
  if (!filled) {
    await page.close();
    const scan = await scanPage(url, context);
    return { ...scan, loginOutcome: 'failed', authFailureReason: 'LOGIN_FORM_NOT_FOUND', authTransitions, authEntryUsed };
  }

  if (await hasPasswordField(page)) {
    const otpField = await page.$(OTP_FIELD_SELECTOR);
    if (otpField && creds.otp) {
      await fillOtpForm(page, creds.otp);
    } else if (otpField && !creds.otp) {
      await page.close();
      const scan = await scanPage(url, context);
      return { ...scan, loginOutcome: 'failed', authFailureReason: 'MFA_REQUIRED', authTransitions, authEntryUsed };
    }
  }

  if (await hasPasswordField(page)) {
    // Credentials (and OTP, if any) were submitted but a password field is
    // still present — the form round-tripped back to itself, i.e. rejected.
    await page.close();
    const scan = await scanPage(url, context);
    return { ...scan, loginOutcome: 'failed', authFailureReason: 'CREDENTIALS_REJECTED', authTransitions, authEntryUsed };
  }

  // Login succeeded. Navigate the CURRENT page to the target URL rather than
  // closing and reopening — SPAs store auth tokens in localStorage/sessionStorage
  // which are per-page and would be lost if we close the tab and open a new one.
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(800);
    const scan = await extractRouteScan(page, url, 200);
    await page.close();
    return { ...scan, loginOutcome: 'success', authTransitions, authEntryUsed };
  } catch {
    // Fallback: open a fresh page in the context (cookie-based auth will still carry over)
    await page.close();
    const scan = await scanPage(url, context);
    return { ...scan, loginOutcome: 'success', authTransitions, authEntryUsed };
  }
}

export async function scanPageWithAuth(
  url: string,
  creds: AuthCredentials
): Promise<AuthScanResult> {
  const browser = await chromium.launch({
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
  });
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
  });
  const deadline = Date.now() + AUTH_DISCOVERY_TIMEOUT_MS;

  try {
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForLoadState('networkidle').catch(() => {});

    if (await hasPasswordField(page)) {
      // A login form is already on the page — no discovery needed.
      return await submitCredentials(page, creds, context, url, 0, undefined);
    }

    let authEntryUsed: string | undefined;
    let transitions = 0;

    while (transitions < MAX_AUTH_TRANSITIONS) {
      if (Date.now() > deadline) {
        await page.close();
        const scan = await scanPage(url, context);
        return { ...scan, loginOutcome: 'failed', authFailureReason: 'AUTH_TIMEOUT', authTransitions: transitions, authEntryUsed };
      }

      const candidates = await findAuthEntryCandidates(page);
      const ranked = rankAuthEntryCandidates(candidates);
      const best = ranked.find((c) => c.score >= MIN_AUTH_ENTRY_SCORE);

      if (!best) {
        await page.close();
        const scan = await scanPage(url, context);
        return {
          ...scan,
          loginOutcome: 'failed',
          authFailureReason: transitions === 0 ? 'AUTH_ENTRY_NOT_FOUND' : 'LOGIN_FORM_NOT_FOUND',
          authTransitions: transitions,
          authEntryUsed,
        };
      }

      try {
        await page.locator(best.selector).first().click({ timeout: 5_000 });
      } catch {
        await page.close();
        const scan = await scanPage(url, context);
        return { ...scan, loginOutcome: 'failed', authFailureReason: 'AUTH_ENTRY_NOT_FOUND', authTransitions: transitions, authEntryUsed };
      }
      authEntryUsed = best.text || best.selector;
      transitions += 1;

      await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});
      const remaining = Math.max(0, deadline - Date.now());
      const appeared = await waitForPasswordField(page, Math.min(8_000, remaining));
      if (appeared) {
        return await submitCredentials(page, creds, context, url, transitions, authEntryUsed);
      }
      // No password field yet — loop again in case this led to an
      // intermediate page (e.g. an account picker) rather than the form itself.
    }

    await page.close();
    const scan = await scanPage(url, context);
    return { ...scan, loginOutcome: 'failed', authFailureReason: 'LOGIN_FORM_NOT_FOUND', authTransitions: transitions, authEntryUsed };
  } finally {
    await context.close();
    await browser.close();
  }
}

type DiscoveryResult = { routes: string[]; forms: FormMeta[]; apis: any[]; scans: RouteScan[] };
type AuthFlowMeta = {
  loginOutcome: LoginOutcome;
  authFailureReason?: AuthFailureReason;
  authEntryUsed?: string;
  authTransitions?: number;
};

export type AuthDiscoveryResult = DiscoveryResult & AuthFlowMeta;

function summarizeScans(scans: RouteScan[]): DiscoveryResult {
  const routes = Array.from(
    new Set(scans.map((s) => safePathFromUrl(effectiveScanUrl(s)))),
  );

  const forms: FormMeta[] = scans.flatMap((scan) => {
    const pathname = safePathFromUrl(effectiveScanUrl(scan));
    const forms = scan.forms?.length
      ? scan.forms
      : (scan.fields?.length
          ? [{ selector: 'form', action: undefined, fields: scan.fields, submitSelectors: [] }]
          : []);
    return forms.map((form) => ({
      selector: form.selector,
      action: form.action,
      fields: form.fields.map((f) => ({
        name: f.name,
        type: f.type,
        required: f.required,
        min: f.min,
        max: f.max,
        pattern: f.pattern,
        label: f.label,
        placeholder: f.placeholder,
        selector: f.selector,
        options: f.options,
      })),
      routeHint: pathname,
    }));
  });

  return { routes, forms, apis: [], scans };
}

async function crawlSiteInContext(
  baseUrl: string,
  context: BrowserContext,
  seedRoutes: string[] = [],
  options: DiscoveryOptions = {},
  existingPage?: Page,
  firstScan?: RouteScan,
): Promise<DiscoveryResult> {
  const MAX = Math.max(1, Math.min(options.maxPages ?? Number(process.env.TM_MAX_ROUTES || 150), 200));
  const start = new URL(baseUrl).toString();
  const page = existingPage ?? await context.newPage();
  const ownPage = !existingPage;
  const scans: RouteScan[] = [];
  const seen = new Set<string>();
  const queue: string[] = [];
  let routeAdvisorCalls = 0;

  try {
    const first = firstScan ?? await scanUrlOnPage(page, start);
    scans.push(first);

    const markSeen = (raw: string) => {
      const normalized = normalizeCrawlUrl(raw, baseUrl);
      if (normalized) seen.add(normalized);
    };
    markSeen(first.url);
    if (first.finalUrl) markSeen(first.finalUrl);

    const enqueueRoutes = (routes: Array<string | undefined | null>) => {
      for (const route of routes) {
        if (scans.length + queue.length >= MAX) break;
        if (!route) continue;
        const normalized = normalizeCrawlUrl(route, baseUrl);
        if (!normalized || seen.has(normalized) || queue.includes(normalized)) continue;
        queue.push(normalized);
      }
    };

    const askRouteAdvisor = async (currentScan: RouteScan): Promise<string[]> => {
      if (!options.routeAdvisor || routeAdvisorCalls >= MAX_AI_ROUTE_DISCOVERY_CALLS) return [];
      const remainingPages = MAX - scans.length - queue.length;
      if (remainingPages <= 0) return [];

      routeAdvisorCalls += 1;
      try {
        const hints = await options.routeAdvisor({
          baseUrl,
          currentScan,
          scans: [...scans],
          remainingPages,
        });
        enqueueRoutes(hints.routes ?? []);
        return hints.selectors ?? [];
      } catch (err: any) {
        console.warn(`[discoverSite] AI route advisor failed: ${err?.message ?? err}`);
        return [];
      }
    };

    enqueueRoutes([
      ...first.links,
      ...((first.controls ?? []).map((control) => control.href).filter(Boolean) as string[]),
      ...seedRoutes,
      start,
    ]);

    const firstAdvisorSelectors = await askRouteAdvisor(first);
    enqueueRoutes(await discoverRoutesByClickingControls(
      page,
      first,
      baseUrl,
      MAX - scans.length - queue.length,
      firstAdvisorSelectors,
    ));

    while (queue.length && scans.length < MAX) {
      const next = queue.shift()!;
      if (seen.has(next)) continue;
      seen.add(next);

      try {
        const scan = await scanUrlOnPage(page, next);
        const effectiveUrl = normalizeCrawlUrl(effectiveScanUrl(scan), baseUrl);
        if (effectiveUrl && effectiveUrl !== next && seen.has(effectiveUrl)) {
          continue;
        }
        scans.push(scan);
        if (scan.finalUrl) markSeen(scan.finalUrl);

        enqueueRoutes([
          ...scan.links,
          ...((scan.controls ?? []).map((control) => control.href).filter(Boolean) as string[]),
        ]);

        const advisorSelectors = await askRouteAdvisor(scan);
        enqueueRoutes(await discoverRoutesByClickingControls(
          page,
          scan,
          baseUrl,
          MAX - scans.length - queue.length,
          advisorSelectors,
        ));
      } catch (err: any) {
        console.warn(`[discoverSite] skipped unreachable page ${next}: ${err?.message ?? err}`);
      }
    }

    return summarizeScans(scans);
  } finally {
    if (ownPage) await page.close();
  }
}

async function submitCredentialsInActivePage(
  page: Page,
  creds: AuthCredentials,
  authTransitions: number,
  authEntryUsed: string | undefined,
): Promise<AuthFlowMeta> {
  const filled = await fillLoginForm(page, creds);
  if (!filled) {
    return { loginOutcome: 'failed', authFailureReason: 'LOGIN_FORM_NOT_FOUND', authTransitions, authEntryUsed };
  }

  const otpField = await page.$(OTP_FIELD_SELECTOR);
  if (otpField) {
    if (!creds.otp) {
      return { loginOutcome: 'failed', authFailureReason: 'MFA_REQUIRED', authTransitions, authEntryUsed };
    }
    await fillOtpForm(page, creds.otp);
  }

  if (await hasPasswordField(page)) {
    return { loginOutcome: 'failed', authFailureReason: 'CREDENTIALS_REJECTED', authTransitions, authEntryUsed };
  }

  return { loginOutcome: 'success', authTransitions, authEntryUsed };
}

async function authenticatePage(page: Page, url: string, creds: AuthCredentials): Promise<AuthFlowMeta> {
  const deadline = Date.now() + AUTH_DISCOVERY_TIMEOUT_MS;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForLoadState('networkidle').catch(() => {});

  if (await hasPasswordField(page)) {
    return await submitCredentialsInActivePage(page, creds, 0, undefined);
  }

  let authEntryUsed: string | undefined;
  let transitions = 0;

  while (transitions < MAX_AUTH_TRANSITIONS) {
    if (Date.now() > deadline) {
      return { loginOutcome: 'failed', authFailureReason: 'AUTH_TIMEOUT', authTransitions: transitions, authEntryUsed };
    }

    const candidates = await findAuthEntryCandidates(page);
    const ranked = rankAuthEntryCandidates(candidates);
    const best = ranked.find((c) => c.score >= MIN_AUTH_ENTRY_SCORE);

    if (!best) {
      return {
        loginOutcome: 'failed',
        authFailureReason: transitions === 0 ? 'AUTH_ENTRY_NOT_FOUND' : 'LOGIN_FORM_NOT_FOUND',
        authTransitions: transitions,
        authEntryUsed,
      };
    }

    try {
      await page.locator(best.selector).first().click({ timeout: 5_000 });
    } catch {
      return { loginOutcome: 'failed', authFailureReason: 'AUTH_ENTRY_NOT_FOUND', authTransitions: transitions, authEntryUsed };
    }

    authEntryUsed = best.text || best.selector;
    transitions += 1;
    await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});

    const remaining = Math.max(0, deadline - Date.now());
    const appeared = await waitForPasswordField(page, Math.min(8_000, remaining));
    if (appeared) {
      return await submitCredentialsInActivePage(page, creds, transitions, authEntryUsed);
    }
  }

  return { loginOutcome: 'failed', authFailureReason: 'LOGIN_FORM_NOT_FOUND', authTransitions: transitions, authEntryUsed };
}

export async function discoverSiteWithAuth(
  baseUrl: string,
  creds: AuthCredentials,
  seedRoutes: string[] = [],
  options: DiscoveryOptions = {},
): Promise<AuthDiscoveryResult> {
  const browser = await chromium.launch({
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
  });
  try {
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
      extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
    });
    try {
      const page = await context.newPage();
      const auth = await authenticatePage(page, baseUrl, creds);
      const currentUrl = page.url() || baseUrl;
      const firstScan = await extractRouteScan(page, currentUrl, 200);

      if (auth.loginOutcome !== 'success') {
        return { ...summarizeScans([firstScan]), ...auth };
      }

      const discovered = await crawlSiteInContext(baseUrl, context, seedRoutes, options, page, firstScan);
      return { ...discovered, ...auth };
    } finally {
      await context.close();
    }
  } finally {
    await browser.close();
  }
}

export async function discoverSite(
  baseUrl: string,
  seedRoutes: string[] = [],
  options: DiscoveryOptions = {},
) {
  const browser = await chromium.launch({
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
  });
  try {
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
      extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
    });

    if (options.cookieString?.trim()) {
      const cookies = parseCookieString(options.cookieString, baseUrl);
      if (cookies.length) await context.addCookies(cookies);
    }

    return await crawlSiteInContext(baseUrl, context, seedRoutes, options);
  } finally {
    await browser.close();
  }
}

type ScanLocatorPage = {
  identity?: { kind: 'text' | 'locator'; text?: string; selector?: string };
  fields: Record<string, string>;
  buttons: Record<string, string>;
  links: Record<string, string>;
  locators: Record<string, string>;
};

/**
 * Seeds a LocatorStore-shaped object from scan data, using the exact same
 * selector strings that casesFromScans() puts into generated test steps.
 * Without this, codegen has no locator-store entry to resolve fill/click/upload
 * steps against and emits "// Missing locator" comments instead of real actions.
 */
export function buildLocatorStoreFromScans(scans: RouteScan[]): { pages: Record<string, ScanLocatorPage>; nav: Record<string, string> } {
  const pages: Record<string, ScanLocatorPage> = {};
  const nav: Record<string, string> = {};

  const ensurePage = (pagePath: string) => {
    if (!pages[pagePath]) pages[pagePath] = { fields: {}, buttons: {}, links: {}, locators: {} };
    return pages[pagePath];
  };

  const setEntry = (pagePath: string, bucket: 'fields' | 'buttons' | 'links' | 'locators', selector: string, keySeed = selector) => {
    if (!selector?.trim()) return;
    ensurePage(pagePath)[bucket][semanticKeyFromString(keySeed)] = selector;
  };

  const cssAttr = (value: string) => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const linkSelector = (href: string) => {
    try {
      const url = new URL(href);
      const rel = `${url.pathname || '/'}${url.search || ''}`;
      return `a[href="${cssAttr(rel)}"], a[href="${cssAttr(url.toString())}"]`;
    } catch {
      return `a[href="${cssAttr(href)}"]`;
    }
  };

  const navKeysForHref = (href: string) => {
    const pathname = safePathFromUrl(href).replace(/^\//, '');
    if (!pathname) return [];
    const kebab = semanticKeyFromString(pathname);
    const camel = kebab.replace(/-([a-z0-9])/g, (_match, ch) => ch.toUpperCase());
    return Array.from(new Set([`nav.${kebab}`, `nav.${camel}`, `nav.${pathname.toLowerCase()}`]));
  };

  const setNavEntry = (href: string, selector: string) => {
    for (const key of navKeysForHref(href)) {
      if (!nav[key]) nav[key] = selector;
    }
  };

  const setIdentity = (pagePath: string, scan: RouteScan) => {
    const page = ensurePage(pagePath);
    const heading = scan.headings?.find((text) => text?.trim());
    if (heading) {
      page.identity = { kind: 'text', text: heading };
      page.locators.pageIdentity = `text=${heading}`;
      return;
    }
    if (scan.title?.trim()) {
      page.identity = { kind: 'text', text: scan.title.trim() };
      page.locators.pageIdentity = `text=${scan.title.trim()}`;
    }
  };

  for (const scan of scans) {
    const pagePath = safePathFromUrl(effectiveScanUrl(scan));
    setIdentity(pagePath, scan);

    for (const f of scan.fields ?? []) {
      if (!f?.name) continue;
      const selector = f.selector || `[name='${f.name}'], #${f.name}`;
      setEntry(pagePath, 'fields', selector);
      setEntry(pagePath, 'fields', selector, f.name);
      if (f.label) setEntry(pagePath, 'fields', selector, f.label);
    }
    if ((scan.fileInputs?.length || 0) > 0) {
      setEntry(pagePath, 'fields', `[name='${scan.fileInputs[0]}']`);
    }
    for (const button of scan.buttons ?? []) {
      setEntry(pagePath, 'buttons', button);
      setEntry(pagePath, 'locators', button);
    }
    if ((scan.fields?.length || 0) > 0 && (scan.buttons?.length || 0) > 0) {
      setEntry(pagePath, 'buttons', "button[type='submit'], input[type='submit']", 'submit');
    }
    for (const control of scan.controls ?? []) {
      setEntry(pagePath, 'buttons', control.selector, control.label || control.selector);
      setEntry(pagePath, 'locators', control.selector, control.label || control.selector);
      if (control.href) {
        setEntry(pagePath, 'links', control.selector, control.href);
        setNavEntry(control.href, control.selector);
      }
    }
    for (const link of scan.links ?? []) {
      const selector = linkSelector(link);
      setEntry(pagePath, 'links', selector, link);
      setEntry(pagePath, 'locators', selector, link);
      setNavEntry(link, selector);
    }
  }

  return { pages, nav };
}
