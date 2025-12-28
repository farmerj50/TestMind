import { Page, test, expect } from '@playwright/test';

const BASE_URL = process.env.TM_BASE_URL ?? process.env.TEST_BASE_URL ?? process.env.BASE_URL ?? 'http://localhost:5173';

type IdentityDescriptor =
  | { kind: 'role'; role: string; name: string }
  | { kind: 'text'; text: string }
  | { kind: 'locator'; selector: string };

const PAGE_IDENTITIES: Record<string, IdentityDescriptor> = {
  "/case-type-selection": {
    "kind": "locator",
    "selector": "text=Select the type of legal issue you're dealing with:"
  }
};

const IDENTITY_CHECK_TIMEOUT = 15000;

function normalizeIdentityPath(target: string): string {
  if (!target) return '/';
  try {
    const parsed = new URL(target, BASE_URL);
    const path = parsed.pathname || '/';
    const search = parsed.search || '';
    return `${path}${search}` || '/';
  } catch {
    if (target.startsWith('/')) return target;
    return `/${target}`;
  }
}

async function ensurePageIdentity(page: Page, target: string) {
  const normalized = normalizeIdentityPath(target);
  const withoutQuery = normalized.split('?')[0] || normalized;
  let identity = PAGE_IDENTITIES[normalized] ?? PAGE_IDENTITIES[withoutQuery];
  if (!identity) {
    const candidates = Object.entries(PAGE_IDENTITIES).filter(([route]) =>
      matchesIdentityPrefix(withoutQuery, route)
    );
    if (candidates.length) {
      identity = candidates.sort((a, b) => b[0].length - a[0].length)[0][1];
    }
  }
  if (!identity) return;
  switch (identity.kind) {
    case 'role':
      await expect(
        page.getByRole(identity.role, { name: identity.name })
      ).toBeVisible({ timeout: IDENTITY_CHECK_TIMEOUT });
      break;
    case 'text': {
      const loc = page.getByText(identity.text);
      if (await loc.count()) {
        await expect(loc.first()).toBeVisible({ timeout: IDENTITY_CHECK_TIMEOUT });
      } else {
        await expect(page).toHaveTitle(new RegExp(escapeRegex(identity.text)), { timeout: IDENTITY_CHECK_TIMEOUT });
      }
      break;
    }
    case 'locator': {
      const locator = page.locator(identity.selector);
      await locator.waitFor({ state: 'visible', timeout: IDENTITY_CHECK_TIMEOUT });
      await expect(locator).toBeVisible({ timeout: IDENTITY_CHECK_TIMEOUT });
      break;
    }
  }
}

function matchesIdentityPrefix(route: string, prefix: string): boolean {
  const normalizedPrefix = prefix || '/';
  if (normalizedPrefix === '/') {
    return route === '/';
  }
  if (route === normalizedPrefix) {
    return true;
  }
  const prefixWithSlash = normalizedPrefix.endsWith('/') ? normalizedPrefix : `${normalizedPrefix}/`;
  return route.startsWith(prefixWithSlash);
}

type Region = 'navigation' | 'header' | 'main';

function getAttributeValue(selector: string, attr: string): string | undefined {
  const regex = new RegExp(`${attr}\s*=\s*['"]([^'\"]+)['"]`, 'i');
  const match = selector.match(regex);
  return match ? match[1] : undefined;
}

function regionScope(page: Page, region?: Region) {
  switch (region) {
    case 'navigation':
      return page.getByRole('navigation');
    case 'header':
      return page.locator('header');
    case 'main':
      return page.locator('main');
    default:
      return page;
  }
}

function chooseLocator(page: Page, selector: string, region?: Region) {
  const scope = regionScope(page, region);
  const testId = getAttributeValue(selector, 'data-testid');
  if (testId) {
    return scope.getByTestId(testId);
  }
  const role = getAttributeValue(selector, 'role');
  if (role) {
    const name = getAttributeValue(selector, 'name');
    return scope.getByRole(role, name ? { name } : undefined);
  }
  return scope.locator(selector);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\\\]]/g, '\$&');
}

function pathRegex(target: string): RegExp {
  const escaped = escapeRegex(target);
  return new RegExp(`^(?:https?:\/\/[^/]+)?${escaped}(?:$|[?#/])`);
}

function identityPathForText(text?: string): string | undefined {
  if (!text) return undefined;
  const normalized = text.trim().toLowerCase();
  if (!normalized) return undefined;
  for (const [path, identity] of Object.entries(PAGE_IDENTITIES)) {
    if (identity.kind === 'role' && identity.name?.toLowerCase() === normalized) {
      return path;
    }
    if (identity.kind === 'text' && identity.text?.toLowerCase().includes(normalized)) {
      return path;
    }
  }
  return undefined;
}

async function clickNavLink(page: Page, target: string): Promise<void> {
  const normalizedPath = normalizeIdentityPath(target);
  const targetSelector = `a[href="${normalizedPath}"]`;
  const scopes = [
    page.getByRole('navigation'),
    page.locator('header'),
    page.locator('main'),
  ];
  for (const scope of scopes) {
    const link = scope.locator(targetSelector);
    if (await link.count()) {
      const candidate = link.first();
      await candidate.waitFor({ state: 'visible', timeout: 15000 });
      await candidate.click({ timeout: 15000 });
      return;
    }
  }
  const fallback = page.locator(targetSelector).first();
  await fallback.waitFor({ state: 'visible', timeout: 15000 });
  await fallback.click({ timeout: 15000 });
}

const SHARED_LOGIN_CONFIG = {
  "usernameSelector": "input[placeholder=\"Email Address\"], input[name=\"email\"], input[type=\"email\"], input[name=\"username\"], #username, #email",
  "passwordSelector": "input[placeholder=\"Password\"], input[name=\"password\"], input[type=\"password\"], #password",
  "submitSelector": "button[type=\"submit\