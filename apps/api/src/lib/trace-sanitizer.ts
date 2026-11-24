import { blocked, readTraceArchive, writeTraceArchive, TRACE_LIMITS, type ArchiveMember } from './trace-archive.js';

export const TRACE_SANITIZER_VERSION = 'pw8-projection-1';
const REDACTED = '[redacted]';
const METHODS = new Set('goto click dblclick fill press check uncheck hover selectOption setInputFiles waitForSelector waitForTimeout waitForLoadState waitForURL screenshot evaluate evaluateHandle querySelector querySelectorAll locator count innerText textContent inputValue isVisible isEnabled getAttribute title url content close newPage newContext launch launchPersistentContext request get post put patch delete fetch head options route unroute addCookies clearCookies cookies storageState setExtraHTTPHeaders setContent reload goBack goForward scrollIntoViewIfNeeded focus blur dispatchEvent waitForFunction waitForResponse waitForRequest expect toBeVisible toBeHidden toHaveText toContainText toHaveURL toHaveTitle toHaveValue toBeChecked toBeEnabled toBeDisabled toHaveCount toHaveAttribute toEqual toBe step beforeAll beforeEach afterAll afterEach'.split(' '));
const CLASSES = new Set(['Page', 'Frame', 'Browser', 'BrowserType', 'BrowserContext', 'APIRequestContext', 'Locator', 'Test', 'Expect', 'Tracing']);
const TAGS = new Set('HTML HEAD BODY TITLE DIV SPAN P A BUTTON FORM LABEL INPUT TEXTAREA SELECT OPTION UL OL LI TABLE THEAD TBODY TR TD TH H1 H2 H3 H4 H5 H6 HEADER FOOTER MAIN NAV SECTION ARTICLE ASIDE STRONG EM B I U BR HR IMG CANVAS SVG PATH G CIRCLE RECT VIDEO AUDIO SOURCE IFRAME FRAME SCRIPT STYLE LINK META BASE NOSCRIPT TEMPLATE #shadow-root'.split(' '));
const number = (value: any, fallback = 0) => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) < Number.MAX_SAFE_INTEGER ? value : fallback;
function json(data: Buffer) {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(data);
  return text;
}
function boundedValue(value: any) {
  const pending = [{ value, depth: 0 }]; let count = 0;
  while (pending.length) {
    const current = pending.pop()!;
    if (++count > 500000 || current.depth > TRACE_LIMITS.depth) blocked();
    if (current.value && typeof current.value === 'object') for (const item of Object.values(current.value)) pending.push({ value: item, depth: current.depth + 1 });
  }
  return value;
}
function records(data: Buffer): any[] {
  const lines = json(data).split('\n').filter(line => line.trim());
  if (lines.length > TRACE_LIMITS.records) blocked();
  return lines.map(line => { const record = boundedValue(JSON.parse(line)); if (!record || Array.isArray(record) || typeof record !== 'object') blocked(); return record; });
}
function secretVariants(values: string[]) {
  return [...new Set(values.filter(Boolean).flatMap(value => [value, encodeURIComponent(value), Buffer.from(value).toString('base64'), Buffer.from(value).toString('base64url'), JSON.stringify(value).slice(1, -1)]))];
}

// Match Trace Viewer's post-order node indices. Check references without expanding
// them into exponentially large DOM trees or permitting recursive reference loops.
function snapshotValidator() {
  const frames = new Map<string, any[][]>();
  const sizes = new WeakMap<object, { count: number; depth: number }>();
  return (frame: string, root: any) => {
    const history = frames.get(frame) ?? []; frames.set(frame, history);
    const nodes: any[] = [];
    const collect = (node: any) => {
      if (typeof node === 'string') nodes.push(node);
      else if (typeof node[0] === 'string') { node.slice(2).forEach(collect); nodes.push(node); }
    };
    collect(root); history.push(nodes); const visiting = new Set<object>();
    const measure = (node: any, index: number, nesting: number): { count: number; depth: number } => {
      if (nesting > TRACE_LIMITS.depth) blocked();
      if (typeof node === 'string') return { count: 1, depth: 1 };
      if (visiting.has(node)) blocked();
      const cached = sizes.get(node); if (cached) return cached;
      visiting.add(node); let count = 1, depth = 1;
      if (Array.isArray(node[0])) {
        const prior = index - node[0][0], target = history[prior]?.[node[0][1]];
        if (prior < 0 || prior > index || target === undefined) blocked();
        const size = measure(target, prior, nesting + 1); count += size.count; depth += size.depth;
      } else for (const child of node.slice(2)) {
        const size = measure(child, index, nesting + 1); count += size.count; depth = Math.max(depth, size.depth + 1);
      }
      if (count > 50000 || depth > TRACE_LIMITS.depth) blocked();
      visiting.delete(node); const result = { count, depth }; sizes.set(node, result); return result;
    };
    measure(root, history.length - 1, 0);
  };
}

// Strict format projection, not a best-effort regex scrub. Opaque payloads, image
// pixels and sources cannot be proven credential-free and never enter the copy.
// Keep action order/timing/failure, network method/status/timing and DOM structure.
export function sanitizeTrace(input: Buffer, knownSecrets: string[] = []): Buffer {
  try {
    const members = readTraceArchive(input), output: ArchiveMember[] = [];
    const ids = new Map<string, string>(), urls = new Map<string, string>();
    const validateSnapshot = snapshotValidator();
    const id = (value: any) => { if (typeof value !== 'string' || !value || value.length > 4096) blocked(); if (!ids.has(value)) ids.set(value, `id-${ids.size + 1}`); return ids.get(value)!; };
    const url = (value: any) => {
      if (typeof value !== 'string') return 'about:blank';
      if (value === 'about:blank') return value;
      // Parse even though no original URL component is exported. Credentials may
      // occur in host/path as well as userinfo/query/fragment.
      let parsed: URL; try { parsed = new URL(value); } catch { return 'about:blank'; }
      if (!['http:', 'https:'].includes(parsed.protocol)) return 'about:blank';
      if (!urls.has(value)) urls.set(value, `https://redacted.invalid/resource-${urls.size + 1}`);
      return urls.get(value)!;
    };
    const viewport = (value: any) => ({ width: Math.max(1, Math.min(10000, number(value?.width, 1280))), height: Math.max(1, Math.min(10000, number(value?.height, 720))) });
    const html = (node: any): any => {
      if (typeof node === 'string') return node.trim() ? REDACTED : ' ';
      if (!Array.isArray(node)) blocked();
      if (Array.isArray(node[0])) {
        if (node.length !== 1 || node[0].length !== 2 || !node[0].every((n: any) => Number.isSafeInteger(n) && n >= 0 && n < 1000000)) blocked();
        return [node[0]]; // preserve delta snapshot node indices
      }
      if (typeof node[0] !== 'string' || (node.length > 1 && (!node[1] || typeof node[1] !== 'object' || Array.isArray(node[1])))) blocked();
      const name = node[0].toUpperCase();
      // Never export executable elements, external references, CSS or attributes.
      const safe = TAGS.has(name) && !['SCRIPT', 'STYLE', 'IFRAME', 'FRAME', 'LINK', 'META', 'BASE', 'SOURCE', 'SVG', 'PATH', 'VIDEO', 'AUDIO'].includes(name) ? name : 'DIV';
      const attrs: Record<string, string> = {};
      if (safe === 'INPUT') attrs.type = 'text';
      return [safe, attrs, ...node.slice(2).map(html)];
    };
    const headers = (value: any) => {
      if (!Array.isArray(value)) return [];
      if (value.length > 1000) blocked();
      return value.map(header => ({ name: ['authorization', 'proxy-authorization', 'cookie', 'set-cookie', 'x-api-key', 'content-type', 'content-length', 'accept', 'host', 'user-agent', 'location'].includes(String(header?.name).toLowerCase()) ? String(header.name).toLowerCase() : 'redacted-header', value: REDACTED }));
    };
    const resource = (snapshot: any) => {
      if (!snapshot?.request || !snapshot?.response) blocked();
      const request = snapshot.request, response = snapshot.response;
      const timing: Record<string, number> = {}; for (const key of ['blocked', 'dns', 'connect', 'send', 'wait', 'receive', 'ssl']) timing[key] = number(snapshot.timings?.[key], -1);
      return { startedDateTime: new Date(number(Date.parse(snapshot.startedDateTime))).toISOString(), time: number(snapshot.time), _monotonicTime: number(snapshot._monotonicTime), ...(snapshot._frameref ? { _frameref: id(snapshot._frameref) } : {}),
        request: { method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'CONNECT', 'TRACE'].includes(request.method) ? request.method : 'GET', url: url(request.url), httpVersion: 'HTTP/1.1', headers: headers(request.headers), cookies: [], queryString: [], headersSize: -1, bodySize: -1, ...(request.postData ? { postData: { mimeType: 'text/plain', text: REDACTED } } : {}) },
        response: { status: Math.max(0, Math.min(599, number(response.status))), statusText: '', httpVersion: 'HTTP/1.1', headers: headers(response.headers), cookies: [], content: { size: REDACTED.length, mimeType: 'text/plain', text: REDACTED }, redirectURL: response.redirectURL ? url(response.redirectURL) : '', headersSize: -1, bodySize: -1 }, cache: {}, timings: timing };
    };
    const traces = members.filter(member => /^[^/]+\.trace$/.test(member.name));
    if (!traces.length || traces.length > 64) blocked();
    const stems = new Set(traces.map(member => member.name.slice(0, -6)));
    for (const member of members) {
      if (/^[^/]+\.(network|stacks)$/.test(member.name) && stems.has(member.name.replace(/\.(network|stacks)$/, ''))) continue;
      if (traces.includes(member)) continue;
      if (/^resources\/[A-Za-z0-9_@.-]+$/.test(member.name)) {
        // No original resource is exported, including PNG/JPEG, source, attachment
        // and opaque body files. Reject nested archives rather than recursively unzip.
        if (member.data.subarray(0, 2).equals(Buffer.from('PK')) || member.data.subarray(0, 2).equals(Buffer.from([0x1f, 0x8b]))) blocked();
        continue;
      }
      blocked();
    }
    let totalRecords = 0;
    for (const [ordinal, trace] of traces.entries()) {
      const events = records(trace.data);
      if (events[0]?.type !== 'context-options' || events[0]?.version !== 8) blocked();
      const seen = new Set<string>(), clean: any[] = [];
      for (const event of events) {
        if (++totalRecords > TRACE_LIMITS.records) blocked();
        const common = { ...(event.pageId ? { pageId: id(event.pageId) } : {}) };
        switch (event.type) {
          case 'context-options':
            if (event !== events[0] || event.version !== 8) blocked();
            clean.push({ type: event.type, version: 8, origin: event.origin === 'testRunner' ? 'testRunner' : 'library', browserName: ['chromium', 'firefox', 'webkit'].includes(event.browserName) ? event.browserName : 'chromium', title: 'Sanitized trace — payloads withheld', platform: 'sanitized', sdkLanguage: 'javascript', wallTime: number(event.wallTime), monotonicTime: number(event.monotonicTime), contextId: id(event.contextId || `context-${ordinal}`), options: { viewport: viewport(event.options?.viewport), deviceScaleFactor: 1, isMobile: false }, testIdAttributeName: 'data-testid' }); break;
          case 'before': {
            if (seen.has(event.callId)) blocked(); seen.add(event.callId);
            const method = METHODS.has(event.method) ? event.method : 'step', cls = CLASSES.has(event.class) ? event.class : 'Test';
            clean.push({ type: event.type, ...common, callId: id(event.callId), startTime: number(event.startTime), apiName: `${cls.toLowerCase()}.${method}`, class: cls, method, title: `${cls}.${method}`, params: event.params?.url ? { url: url(event.params.url) } : {}, ...(event.parentId ? { parentId: id(event.parentId) } : {}), ...(event.beforeSnapshot ? { beforeSnapshot: id(event.beforeSnapshot) } : {}), stepId: id(event.stepId || event.callId) }); break;
          }
          case 'after':
            if (!seen.has(event.callId)) blocked();
            clean.push({ type: event.type, callId: id(event.callId), endTime: number(event.endTime), ...(event.afterSnapshot ? { afterSnapshot: id(event.afterSnapshot) } : {}), ...(event.error ? { error: { name: 'Error', message: 'Action failed; sensitive error details withheld.' } } : {}) }); break;
          case 'input':
            if (!seen.has(event.callId)) blocked();
            clean.push({ type: event.type, callId: id(event.callId), ...(event.inputSnapshot ? { inputSnapshot: id(event.inputSnapshot) } : {}) }); break;
          case 'log':
            if (!seen.has(event.callId)) blocked();
            clean.push({ type: 'log', callId: id(event.callId), time: number(event.time), message: REDACTED }); break;
          case 'frame-snapshot': {
            const s = event.snapshot; if (!s) blocked();
            const safeHtml = html(s.html); validateSnapshot(id(s.frameId), safeHtml);
            clean.push({ type: event.type, snapshot: { callId: id(s.callId || s.snapshotName), snapshotName: id(s.snapshotName), pageId: id(s.pageId), frameId: id(s.frameId), frameUrl: url(s.frameUrl), timestamp: number(s.timestamp), wallTime: number(s.wallTime), isMainFrame: s.isMainFrame === true, viewport: viewport(s.viewport), doctype: 'html', html: safeHtml, resourceOverrides: [] } }); break;
          }
          case 'resource-snapshot': clean.push({ type: event.type, snapshot: resource(event.snapshot) }); break;
          case 'error': clean.push({ type: 'error', message: 'Error details withheld from sanitized trace.' }); break;
          case 'stdout': case 'stderr': clean.push({ type: event.type, timestamp: number(event.timestamp), text: REDACTED }); break;
          case 'event': case 'console': case 'screencast-frame': break; // free-form payloads and image pixels are withheld
          default: blocked();
        }
      }
      output.push({ name: `context-${ordinal}.trace`, data: Buffer.from(clean.map(event => JSON.stringify(event)).join('\n') + '\n') });
      const network = members.find(member => member.name === trace.name.replace(/\.trace$/, '.network'));
      const networkEvents = network ? records(network.data) : [];
      totalRecords += networkEvents.length; if (totalRecords > TRACE_LIMITS.records) blocked();
      if (networkEvents.some(event => event.type !== 'resource-snapshot')) blocked();
      output.push({ name: `context-${ordinal}.network`, data: Buffer.from(networkEvents.map(event => JSON.stringify({ type: 'resource-snapshot', snapshot: resource(event.snapshot) })).join('\n')) });
      const stacks = members.find(member => member.name === trace.name.replace(/\.trace$/, '.stacks'));
      if (stacks) boundedValue(JSON.parse(json(stacks.data))); // parse before deliberately omitting source paths/stacks
    }
    const result = writeTraceArchive(output);
    // Validate every emitted member, not just the compressed archive's byte string.
    const variants = secretVariants(knownSecrets);
    for (const member of readTraceArchive(result)) {
      records(member.data);
      if (variants.some(secret => member.name.includes(secret) || member.data.includes(Buffer.from(secret)))) blocked();
    }
    return result;
  } catch { return blocked(); }
}
