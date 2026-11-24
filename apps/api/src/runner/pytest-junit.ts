import { SaxesParser } from 'saxes';
import { normalizePytestResults, type PytestCase, type PytestResultInput } from './pytest-results.js';

export const MAX_JUNIT_BYTES = 2 * 1024 * 1024;
type Element = { name: string; attrs: Record<string, string>; children: Element[]; text: string };
const invalid = () => { throw new Error('Invalid pytest JUnit report.'); };

/** Strict, bounded XML parsing. Diagnostics are private runner data, never public artifacts. */
export function parsePytestJUnit(xml: string | undefined): { cases: PytestCase[]; reportState: 'complete' | 'invalid' | 'missing' } {
  if (xml === undefined) return { cases: [], reportState: 'missing' };
  try {
    if (typeof xml !== 'string' || !xml.trim() || Buffer.byteLength(xml) > MAX_JUNIT_BYTES) invalid();
    const stack: Element[] = [];
    let root: Element | undefined, nodes = 0;
    const parser = new SaxesParser({ xmlns: false });
    parser.on('error', invalid);
    parser.on('doctype', invalid);
    parser.on('processinginstruction', invalid);
    parser.on('xmldecl', declaration => {
      if (declaration.version !== '1.0' || (declaration.encoding && !/^utf-8$/i.test(declaration.encoding))) invalid();
    });
    parser.on('opentag', tag => {
      if (++nodes > 40_000 || stack.length >= 12 || tag.name.includes(':')) invalid();
      const element: Element = { name: tag.name, attrs: tag.attributes, children: [], text: '' };
      if (stack.length) stack[stack.length - 1].children.push(element);
      else if (root) invalid();
      else root = element;
      stack.push(element);
    });
    const text = (value: string) => { if (stack.length) stack[stack.length - 1].text += value; };
    parser.on('text', text);
    parser.on('cdata', text);
    parser.on('closetag', () => { stack.pop(); });
    parser.write(xml).close();
    if (!root || !['testsuites', 'testsuite'].includes(root.name)) invalid();
    const cases: PytestCase[] = [];
    const ids = new Set<string>();
    const metadata = (element: Element) => {
      if (element.name === 'properties') {
        if (element.children.some(child => child.name !== 'property' || child.children.length)) invalid();
      } else if (!['system-out', 'system-err'].includes(element.name) || element.children.length) invalid();
    };
    const visit = (element: Element) => {
      const start = cases.length;
      if (element.text.trim()) invalid();
      for (const child of element.children) {
        if (child.name === 'testsuite') visit(child);
        else if (child.name === 'testcase' && element.name === 'testsuite') {
          const { name, classname = '', file = 'unknown', time } = child.attrs;
          if (!name || child.text.trim() || cases.length >= 10_000) invalid();
          // JSON tuple avoids collisions between delimiters inside parameter names.
          const id = JSON.stringify([classname, name]);
          if (ids.has(id)) invalid();
          ids.add(id);
          const states = child.children.filter(item => ['failure', 'error', 'skipped'].includes(item.name));
          if (states.length > 1 || states.some(item => item.children.length)) invalid();
          for (const item of child.children) if (!states.includes(item)) metadata(item);
          const scriptProperties = child.children.filter(item => item.name === 'properties').flatMap(item => item.children)
            .filter(item => ['testmind.python.status', 'testmind.python.result'].includes(item.attrs.name));
          let scriptResult: PytestCase['scriptResult'];
          if (scriptProperties.length) {
            const status = scriptProperties.filter(item => item.attrs.name === 'testmind.python.status');
            const value = scriptProperties.filter(item => item.attrs.name === 'testmind.python.result');
            if (status.length !== 1 || !['completed', 'assertion', 'error'].includes(status[0].attrs.value)
              || value.length > 1 || scriptProperties.some(item => item.text.trim())
              || (status[0].attrs.value === 'completed' ? value.length !== 1 : value.length !== 0)
              || value.some(item => typeof item.attrs.value !== 'string' || Buffer.byteLength(item.attrs.value) > 65536)) invalid();
            scriptResult = { status: status[0].attrs.value as NonNullable<PytestCase['scriptResult']>['status'], json: value[0]?.attrs.value };
          }
          const state = states[0];
          const durationMs = time === undefined ? undefined : Number(time) * 1000;
          if (time !== undefined && (!/^\d+(?:\.\d+)?$/.test(time) || !Number.isFinite(durationMs))) invalid();
          const message = state ? [state.attrs.message, state.text].filter(Boolean).join('\n') : null;
          const phase = state?.name !== 'error' ? undefined
            : /^collection failure(?:\b|$)/i.test(state.attrs.message ?? '') ? 'collection'
            : /^failed on setup with\b/i.test(state.attrs.message ?? '') ? 'setup'
            : /^failed on teardown with\b/i.test(state.attrs.message ?? '') ? 'teardown' : undefined;
          cases.push({ id, file, fullName: [classname, name].filter(Boolean).join('::'), durationMs,
            status: !state ? 'passed' : state.name === 'failure' ? 'failed' : state.name === 'error' ? 'error' : 'skipped',
            phase, message, ...(scriptResult ? { scriptResult } : {}),
            stdout: child.children.filter(item => item.name === 'system-out').map(item => item.text),
            stderr: child.children.filter(item => item.name === 'system-err').map(item => item.text),
            attachments: [],
          });
        } else if (element.name === 'testsuite') metadata(child);
        else invalid();
      }
      const subset = cases.slice(start);
      for (const [key, count] of Object.entries({ tests: subset.length, failures: subset.filter(c => c.status === 'failed').length,
        errors: subset.filter(c => c.status === 'error').length, skipped: subset.filter(c => c.status === 'skipped').length })) {
        const supplied = element.attrs[key];
        if (supplied !== undefined && (!/^\d+$/.test(supplied) || Number(supplied) !== count)) invalid();
      }
    };
    visit(root);
    return { cases, reportState: 'complete' };
  } catch {
    // Never propagate parser messages: they can contain credentials from XML.
    return { cases: [], reportState: 'invalid' };
  }
}

export function normalizePytestJUnit(xml: string | undefined, execution: Omit<PytestResultInput, 'cases' | 'reportState'>) {
  return normalizePytestResults({ ...execution, ...parsePytestJUnit(xml) });
}
