import type { FastifyInstance } from 'fastify';
import { getAuth } from '@clerk/fastify';
import { lookup as dnsLookup } from 'node:dns/promises';
import {
  discoverSite,
  discoverSiteWithAuth,
  scanPage,
  buildLocatorStoreFromScans,
  type AuthCredentials,
  type AuthFailureReason,
  type RouteScan,
} from '../testmind/discover.js';
import { generatePlanWithAI, fillMissingFamilies, type RichTestCase } from '../testmind/pipeline/generate-plan-ai.js';
import { suggestRouteDiscoveryWithAI } from '../testmind/pipeline/route-discovery-ai.js';
import { emitSpecFilesByPage } from '../testmind/adapters/playwright-ts/generator.js';
import { prisma } from '../prisma.js';

// ── SSRF guard ────────────────────────────────────────────────────────────────

function isPrivateIp(ip: string): boolean {
  const privatePatterns = [
    /^127\./,
    /^10\./,
    /^192\.168\./,
    /^172\.(1[6-9]|2\d|3[01])\./,
    /^169\.254\./,
    /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
    /^0\./,
    /^255\./,
  ];
  if (privatePatterns.some((re) => re.test(ip))) return true;
  if (ip === '::1') return true;
  if (/^fe[89ab][0-9a-f]:/i.test(ip)) return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(ip)) return true;
  return false;
}

async function assertSafeUrl(raw: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw Object.assign(new Error('Invalid URL'), { statusCode: 400 });
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw Object.assign(new Error('Only http and https URLs are allowed'), { statusCode: 400 });
  }
  try {
    const { address } = await dnsLookup(parsed.hostname);
    if (isPrivateIp(address)) {
      throw Object.assign(new Error('URL resolves to a private network address'), { statusCode: 400 });
    }
  } catch (err: any) {
    if (err.statusCode) throw err;
    throw Object.assign(new Error('Could not resolve hostname'), { statusCode: 400 });
  }
  return parsed;
}

// ── Warning codes ─────────────────────────────────────────────────────────────

type Warning = { code: string; message: string; severity: 'info' | 'warning' | 'error' };
type ScanPhase = 'auth_required' | 'auth_failed' | 'partial' | 'ready';

const AUTH_PATH_RE = /\/(login|signin|sign-in|auth|sso|oauth|account\/login)/i;
const DEFAULT_URL_INSPECTOR_MAX_PAGES = 30;

function boundedMaxPages(raw: unknown): number {
  const parsed = Number(raw ?? process.env.URL_INSPECTOR_MAX_ROUTES ?? DEFAULT_URL_INSPECTOR_MAX_PAGES);
  if (!Number.isFinite(parsed)) return DEFAULT_URL_INSPECTOR_MAX_PAGES;
  return Math.max(1, Math.min(Math.floor(parsed), 100));
}

function effectiveScanUrl(scan: RouteScan): string {
  return scan.finalUrl || scan.url;
}

function scanPathname(scan: RouteScan): string {
  try {
    return new URL(effectiveScanUrl(scan)).pathname || '/';
  } catch {
    return '/';
  }
}

function routePathFromValue(value?: string): string {
  if (!value) return '/';
  try {
    const parsed = new URL(value, 'http://testmind.local');
    return `${parsed.pathname || '/'}${parsed.search || ''}`;
  } catch {
    return value.startsWith('/') ? value : `/${value}`;
  }
}

function testCaseRoutePath(tc: { group?: { page?: string; url?: string }; steps?: Array<any> }): string {
  const grouped = tc.group?.page || tc.group?.url;
  if (grouped) return routePathFromValue(grouped);
  const firstGoto = tc.steps?.find((step) => step?.kind === 'goto' && step.url);
  return routePathFromValue(firstGoto?.url);
}

function suiteNameForRoute(pathname: string): string {
  return `URL Inspection - ${pathname || '/'}`;
}

function combineSpecFiles(specFiles: Array<{ path: string; content: string }>): string {
  return specFiles
    .map((file) => `// ${file.path}\n${file.content}`)
    .join('\n\n');
}

function buildPageResponse(scan: RouteScan, origin: string, locatorStore: any) {
  const pathname = scanPathname(scan);
  const locatorPage = locatorStore?.pages?.[pathname];

  const forms = (scan.forms ?? []).map((form) => ({
    selector: form.selector,
    action: form.action,
    fields: form.fields.map((f) => ({
      name: f.name,
      type: f.type ?? 'text',
      label: f.label || f.name,
      selector: f.selector ?? locatorPage?.fields?.[f.name] ?? `[name='${f.name}'], #${f.name}`,
    })),
    submit: form.submitSelectors[0]
      ? {
          label: extractButtonLabel(form.submitSelectors[0]),
          selector: form.submitSelectors[0],
        }
      : undefined,
  }));

  const buttons = scan.buttons.slice(0, 80).map((sel) => ({
    label: extractButtonLabel(sel),
    selector: sel,
  }));

  const links = scan.links.slice(0, 80).map((href) => ({
    text: href.replace(origin, '') || href,
    href,
  }));

  return {
    requestedUrl: scan.url,
    finalUrl: effectiveScanUrl(scan),
    title: scan.title || '',
    pathname,
    forms,
    buttons,
    fields: scan.fields.map((f) => ({
      name: f.name,
      type: f.type ?? 'text',
      label: f.label || f.name,
      selector: f.selector ?? `[name='${f.name}'], #${f.name}`,
    })),
    links,
    headings: scan.headings ?? [],
  };
}

// ── Deduplication & matrix helpers ────────────────────────────────────────────

type PriorCase = {
  id: string;
  name: string;
  group?: { page?: string; url?: string };
  steps?: unknown[];
  coverageType?: string;
};

function normalizeCaseName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}

function deriveRouteFromCase(tc: PriorCase): string {
  const grouped = tc.group?.page || tc.group?.url;
  if (grouped) {
    try { return new URL(grouped, 'http://testmind.local').pathname || '/'; } catch { return grouped; }
  }
  const firstGoto = (tc.steps as any[])?.find((s: any) => s?.kind === 'goto' && s.url);
  if (firstGoto?.url) {
    try { return new URL(firstGoto.url, 'http://testmind.local').pathname || '/'; } catch {}
  }
  return '/';
}

function semanticDedupe<T extends PriorCase>(
  cases: T[]
): { deduped: T[]; duplicatesRemoved: number } {
  const seen = new Map<string, T>();
  let duplicatesRemoved = 0;
  for (const tc of cases) {
    const route = deriveRouteFromCase(tc);
    const normalName = normalizeCaseName(tc.name);
    const coverageType = tc.coverageType ?? '';
    const key = `${normalName}|${coverageType}|${route}`;
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, tc);
    } else {
      duplicatesRemoved++;
      // Keep the richer case (more steps)
      if ((tc.steps?.length ?? 0) > (existing.steps?.length ?? 0)) {
        seen.set(key, tc);
      }
    }
  }
  return { deduped: Array.from(seen.values()), duplicatesRemoved };
}

type CoverageStatusValue = 'covered' | 'partial' | 'runtime_required' | 'not_applicable';
const STATUS_RANK: Record<CoverageStatusValue, number> = {
  covered: 3,
  partial: 2,
  runtime_required: 1,
  not_applicable: 0,
};

function mergeMatrices(
  matrices: Array<Record<string, string> | undefined>
): Record<string, CoverageStatusValue> {
  const result: Record<string, CoverageStatusValue> = {};
  for (const matrix of matrices) {
    if (!matrix) continue;
    for (const [key, value] of Object.entries(matrix)) {
      const current = result[key] ?? 'not_applicable';
      const currentRank = STATUS_RANK[current as CoverageStatusValue] ?? 0;
      const newRank = STATUS_RANK[value as CoverageStatusValue] ?? 0;
      if (newRank > currentRank) {
        result[key] = value as CoverageStatusValue;
      }
    }
  }
  return result;
}

type RoutePlanStatus = 'covered' | 'partial' | 'generation_failed';
type RoutePlan = {
  route: string;
  status: RoutePlanStatus;
  cases: any[];
  executableCases: any[];
  runtimeCases: any[];
  coverageMatrix?: Record<string, string>;
  capabilities?: string[];
  gaps?: string[];
  observedCount?: number;
  inferredCount?: number;
};

// ── Routes ────────────────────────────────────────────────────────────────────

export default async function urlInspectorRoutes(app: FastifyInstance) {
  // POST /url-inspector/scan — non-destructive, no DB writes
  app.post('/url-inspector/scan', async (req, reply) => {
    const { userId } = getAuth(req);
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

    const { url: rawUrl, instructions, credentials, maxPages, priorCases } = (req.body ?? {}) as {
      url?: string;
      instructions?: string;
      credentials?: { username?: string; password?: string; otp?: string };
      maxPages?: number;
      priorCases?: PriorCase[];
    };

    if (!rawUrl?.trim()) return reply.code(400).send({ error: 'url is required' });

    let parsedUrl: URL;
    try {
      parsedUrl = await assertSafeUrl(rawUrl.trim());
    } catch (err: any) {
      return reply.code(err.statusCode ?? 400).send({ error: err.message });
    }

    const hasCredentials = !!(credentials?.username?.trim() && credentials?.password?.trim());
    const authCreds: AuthCredentials | undefined = hasCredentials
      ? { username: credentials!.username!.trim(), password: credentials!.password!, otp: credentials?.otp?.trim() || undefined }
      : undefined;

    const routeLimit = boundedMaxPages(maxPages);
    let scans: RouteScan[] = [];
    let loginOutcome: string = 'not_needed';
    let authFailureReason: AuthFailureReason | undefined;
    let authEntryUsed: string | undefined;
    let authTransitions: number | undefined;
    const routeAdvisor = async (input: {
      baseUrl: string;
      currentScan: RouteScan;
      scans: RouteScan[];
      remainingPages: number;
    }) => suggestRouteDiscoveryWithAI(input.scans, {
      baseUrl: parsedUrl.origin,
      instructions: instructions?.trim(),
      remainingPages: input.remainingPages,
    });

    try {
      if (authCreds) {
        const result = await discoverSiteWithAuth(parsedUrl.toString(), authCreds, [], { maxPages: routeLimit, routeAdvisor });
        loginOutcome = result.loginOutcome;
        authFailureReason = result.authFailureReason;
        authEntryUsed = result.authEntryUsed;
        authTransitions = result.authTransitions;
        scans = result.scans;
      } else if (AUTH_PATH_RE.test(parsedUrl.pathname)) {
        scans = [await scanPage(parsedUrl.toString())];
      } else {
        const result = await discoverSite(parsedUrl.toString(), [], { maxPages: routeLimit, routeAdvisor });
        scans = result.scans;
      }
    } catch (err: any) {
      return reply.code(502).send({ error: `Failed to scan page: ${err?.message ?? 'Unknown error'}` });
    }

    if (!scans.length) {
      return reply.code(502).send({ error: 'Failed to scan page: no pages were discovered' });
    }

    const primaryScan = scans[0];
    const locatorStore = buildLocatorStoreFromScans(scans);

    const pagesResponse = scans.map((scan) => buildPageResponse(scan, parsedUrl.origin, locatorStore));
    const primaryPage = pagesResponse[0];

    // Warnings
    const warnings: Warning[] = [];
    let phase: ScanPhase = 'ready';
    if (!authCreds && AUTH_PATH_RE.test(parsedUrl.pathname)) {
      warnings.push({
        code: 'AUTH_PAGE_WITHOUT_CREDENTIALS',
        message: 'This URL looks like a login page. Add credentials under "Page requires login?" so TestMind can scan authenticated routes behind it.',
        severity: 'warning',
      });
      phase = 'auth_required';
    }

    const finalUrl = primaryPage.finalUrl ?? parsedUrl.toString();
    if (primaryScan.finalUrl) {
      try {
        const finalPath = new URL(finalUrl).pathname;
        if (AUTH_PATH_RE.test(finalPath) && loginOutcome !== 'success') {
          warnings.push({
            code: 'AUTH_REDIRECT',
            message: 'The page redirected to a login URL — authentication may be required for full coverage.',
            severity: 'warning',
          });
          if (!authCreds) phase = 'auth_required';
        }
      } catch { /* ignore */ }
    }

    if (authCreds && loginOutcome !== 'success') {
      phase = 'auth_failed';
    }

    const interactiveElements = scans.reduce((sum, scan) => sum + scan.fields.length + scan.buttons.length, 0);
    const formCount = scans.reduce((sum, scan) => sum + (scan.forms?.length ?? 0), 0);
    const buttonCount = scans.reduce((sum, scan) => sum + scan.buttons.length, 0);
    const linkCount = new Set(scans.flatMap((scan) => scan.links)).size;

    if (interactiveElements === 0) {
      warnings.push({
        code: 'NO_INTERACTIVE_ELEMENTS',
        message: 'No interactive elements (forms, inputs, buttons, links, or controls) were found on the scanned pages.',
        severity: 'info',
      });
    }

    // ── Per-route AI generation — batched to avoid TPM saturation ────────────────
    // 13 concurrent routes × 2 passes each saturates the 200K TPM limit.
    // Run at most URL_INSPECTOR_AI_CONCURRENCY routes at a time (default 3).

    const AI_CONCURRENCY = Math.max(1, Math.min(
      Number(process.env.URL_INSPECTOR_AI_CONCURRENCY ?? 3),
      scans.length
    ));

    async function planRoute(scan: RouteScan): Promise<RoutePlan> {
      const route = scanPathname(scan);
      try {
        const plan = await generatePlanWithAI([scan], locatorStore, {
          baseUrl: parsedUrl.origin,
          instructions: instructions?.trim(),
        });
        return {
          route,
          status: plan.executableCases.length > 0 ? 'covered' : 'partial',
          cases: plan.cases,
          executableCases: plan.executableCases,
          runtimeCases: plan.cases.filter((c: any) => c.validation === 'runtime_required'),
          coverageMatrix: plan.coverageMatrix,
          capabilities: plan.capabilities,
          gaps: plan.gaps,
          observedCount: plan.observedCount,
          inferredCount: plan.inferredCount,
        };
      } catch {
        return {
          route,
          status: 'generation_failed',
          cases: [],
          executableCases: [],
          runtimeCases: [],
        };
      }
    }

    const routePlanSettled: PromiseSettledResult<RoutePlan>[] = [];
    for (let i = 0; i < scans.length; i += AI_CONCURRENCY) {
      const batch = scans.slice(i, i + AI_CONCURRENCY);
      console.log(`[url-inspector] AI batch ${Math.floor(i / AI_CONCURRENCY) + 1}: routes ${i + 1}–${Math.min(i + AI_CONCURRENCY, scans.length)} of ${scans.length}`);
      const batchResults = await Promise.allSettled(batch.map(planRoute));
      routePlanSettled.push(...batchResults);
    }

    const routePlans: RoutePlan[] = routePlanSettled.map((r, i) =>
      r.status === 'fulfilled'
        ? r.value
        : {
            route: scanPathname(scans[i]),
            status: 'generation_failed' as RoutePlanStatus,
            cases: [],
            executableCases: [],
            runtimeCases: [],
          }
    );

    const hasFailedRoutes = routePlans.some((p) => p.status === 'generation_failed');
    if (hasFailedRoutes && phase === 'ready') phase = 'partial';

    // Combine current scan cases with any prior cases from an unauthenticated scan
    const newCases = routePlans.flatMap((p) => p.cases);
    const rawCombined = [...(priorCases ?? []), ...newCases];
    const { deduped: allCases, duplicatesRemoved } = semanticDedupe(rawCombined);

    // ── Family-fill pass — ONE combined call for all routes ───────────────────
    let matrixPatch: Partial<Record<string, string>> = {};
    try {
      const fillResult = await fillMissingFamilies(scans, locatorStore, {
        baseUrl: parsedUrl.origin,
        instructions: instructions?.trim(),
      }, allCases as RichTestCase[]);
      matrixPatch = fillResult.matrixPatch;
      if (fillResult.cases.length > 0) {
        const { deduped: allCasesWithFill } = semanticDedupe([...allCases, ...fillResult.cases]);
        allCases.splice(0, allCases.length, ...allCasesWithFill);
      }
    } catch (err: any) {
      app.log.warn({ err }, '[url-inspector] fillMissingFamilies failed — continuing without family fill');
    }

    // Counts from the deduped set so they never exceed the displayed total
    const totalObserved = allCases.filter((tc: any) => tc.evidence === 'observed').length;
    const totalInferred = allCases.filter((tc: any) => tc.evidence === 'inferred').length;
    const runtimeCount = allCases.filter((tc: any) => tc.validation === 'runtime_required').length;
    const familyCounts: Record<string, number> = {};
    for (const tc of allCases) {
      const ct = (tc as any).coverageType ?? 'happyPath';
      familyCounts[ct] = (familyCounts[ct] ?? 0) + 1;
    }

    // Merged coverage across all route plans
    const mergedMatrix = mergeMatrices(routePlans.map((p) => p.coverageMatrix));
    // Apply fill's matrix corrections (fill cases don't appear in per-route matrices)
    Object.assign(mergedMatrix, matrixPatch);

    // Reconcile matrix against final aggregated allCases — source of truth after all passes.
    // Cases exist that routes never reported (runtime-required, fill cases, etc.).
    for (const [family, count] of Object.entries(familyCounts)) {
      if (count <= 0) continue;
      const familyCases = allCases.filter((tc: any) => tc.coverageType === family);
      const hasStatic = familyCases.some((tc: any) => tc.validation === 'static');
      const hasRuntime = familyCases.some((tc: any) => tc.validation === 'runtime_required');
      if (hasStatic) {
        if (!mergedMatrix[family] || mergedMatrix[family] === 'not_applicable') {
          mergedMatrix[family] = 'partial';
        }
      } else if (hasRuntime) {
        mergedMatrix[family] = 'runtime_required';
      }
    }

    const allCapabilities = Array.from(new Set(routePlans.flatMap((p) => p.capabilities ?? [])));
    const allGaps = Array.from(new Set(routePlans.flatMap((p) => p.gaps ?? [])));
    const failedRouteCount = routePlans.filter((p) => p.status === 'generation_failed').length;

    // Auth-context and failure gaps
    const authGaps: string[] =
      phase === 'auth_required'
        ? ['Test cases cover the unauthenticated surface only. Authenticate to discover full route coverage.']
        : phase === 'auth_failed'
        ? ['Authentication failed — test cases cover the login page only.']
        : [];
    const failureGaps: string[] =
      failedRouteCount > 0
        ? [`${failedRouteCount} route${failedRouteCount !== 1 ? 's' : ''} could not be fully analyzed — AI generation failed or timed out.`]
        : [];
    const coverageGaps = [...authGaps, ...failureGaps, ...allGaps];

    // Spec generation — only static cases with actionable + assertion steps
    const executableCases = allCases.filter(
      (tc: any) =>
        tc.validation === 'static' &&
        tc.steps?.some((s: any) => ['fill', 'click', 'goto'].includes(s.kind)) &&
        tc.steps?.some((s: any) => ['expect-text', 'expect-visible'].includes(s.kind))
    );

    let specFiles: ReturnType<typeof emitSpecFilesByPage> = [];
    let specContent = '';
    try {
      specFiles = emitSpecFilesByPage(executableCases, {
        locatorStore,
        baseUrl: parsedUrl.origin,
      });
      specContent = combineSpecFiles(specFiles);
    } catch (err: any) {
      app.log.warn({ err }, '[url-inspector] emitSpecFilesByPage failed');
    }

    const unresolvedCount = allCases.flatMap((tc: any) => tc.steps ?? [])
      .filter((s: any) => s.kind === 'custom').length;
    if (unresolvedCount > 0) {
      warnings.push({
        code: 'UNRESOLVED_LOCATORS',
        message: `${unresolvedCount} step${unresolvedCount !== 1 ? 's' : ''} could not be mapped to a stable selector.`,
        severity: 'warning',
      });
    }

    return reply.send({
      phase,
      page: primaryPage,
      pages: pagesResponse,
      generation: {
        testCases: allCases,
        specContent,
        specFiles,
        warnings,
      },
      summary: {
        interactiveElements,
        forms: formCount,
        buttons: buttonCount,
        links: linkCount,
        routes: pagesResponse.length,
        testCases: allCases.length,
        unresolvedLocators: unresolvedCount,
      },
      coverage: {
        capabilities: allCapabilities,
        matrix: mergedMatrix,
        gaps: coverageGaps,
        observedCount: totalObserved,
        inferredCount: totalInferred,
        runtimeRequiredCount: runtimeCount,
        familyCounts,
      },
      routes: routePlans.map((p) => ({
        route: p.route,
        status: p.status,
        testCaseCount: p.executableCases.length,
        runtimeCaseCount: p.runtimeCases.length,
        coverageMatrix: p.coverageMatrix,
      })),
      duplicatesRemoved,
      auth: { loginOutcome, authFailureReason, authEntryUsed, authTransitions },
    });
  });

  // POST /url-inspector/save — save generated test cases to a project
  app.post('/url-inspector/save', async (req, reply) => {
    const { userId } = getAuth(req);
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

    const { projectId, url: sourceUrl, testCases, specFiles } = (req.body ?? {}) as {
      projectId?: string;
      url?: string;
      testCases?: Array<{ id: string; name: string; group?: { page?: string; url?: string }; steps: unknown[] }>;
      specFiles?: Array<{ path: string; page: string; testCount: number }>;
    };

    if (!projectId) return reply.code(400).send({ error: 'projectId is required' });
    if (!Array.isArray(testCases) || testCases.length === 0) {
      return reply.code(400).send({ error: 'testCases must be a non-empty array' });
    }

    const project = await prisma.project.findUnique({ where: { id: projectId }, select: { ownerId: true } });
    if (!project) return reply.code(404).send({ error: 'Project not found' });
    if (project.ownerId !== userId) return reply.code(403).send({ error: 'Forbidden' });


    const casesByRoute = new Map<string, Array<{ id: string; name: string; group?: { page?: string; url?: string }; steps: unknown[] }>>();
    for (const tc of testCases) {
      const routePath = testCaseRoutePath(tc);
      const routeCases = casesByRoute.get(routePath) ?? [];
      routeCases.push(tc);
      casesByRoute.set(routePath, routeCases);
    }

    const suitesByRoute = new Map<string, { id: string; name: string }>();
    for (const routePath of casesByRoute.keys()) {
      const routeSuiteName = suiteNameForRoute(routePath);
      let routeSuite = await prisma.testSuite.findFirst({
        where: { projectId, name: routeSuiteName },
        select: { id: true, name: true },
      });
      if (!routeSuite) {
        routeSuite = await prisma.testSuite.create({
          data: { projectId, name: routeSuiteName },
          select: { id: true, name: true },
        });
      }
      suitesByRoute.set(routePath, routeSuite);
    }

    const savedCases = await prisma.$transaction(
      Array.from(casesByRoute.entries()).flatMap(([routePath, routeCases]) => {
        const routeSuite = suitesByRoute.get(routePath)!;
        const specFile = specFiles?.find((file) => routePathFromValue(file.page) === routePath);
        return routeCases.map((tc) =>
          prisma.testCase.create({
            data: {
              projectId,
              suiteId: routeSuite.id,
              title: tc.name,
              status: 'draft',
              lastSource: 'url-builder',
              preconditions: JSON.stringify({
                sourceUrl: sourceUrl ?? null,
                route: routePath,
                specPath: specFile?.path ?? null,
              }),
              locators: JSON.stringify(tc.steps),
            },
            select: { id: true },
          })
        );
      })
    );

    return reply.send({
      saved: {
        testCaseCount: savedCases.length,
        projectId,
        suiteCount: suitesByRoute.size,
        suites: Array.from(suitesByRoute.entries()).map(([route, suite]) => ({
          route,
          suiteId: suite.id,
          name: suite.name,
        })),
      },
    });
  });
}

function extractButtonLabel(selector: string): string {
  const m = selector.match(/button:has-text\("([^"]+)"\)/);
  if (m) return m[1];
  if (selector.includes('submit')) return 'Submit';
  if (selector.includes('input[type=')) return selector;
  return selector.slice(0, 40);
}
