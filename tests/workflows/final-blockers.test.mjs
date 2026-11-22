import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { loadTs } from './operator-harness.mjs';
const require = createRequire(import.meta.url);
const { tsImport } = require('tsx/esm/api');
const generator = await tsImport(new URL('../../apps/api/src/testmind/adapters/playwright-ts/generator.ts', import.meta.url).href, import.meta.url);
const analysis = loadTs('apps/api/src/lib/workflow-evidence.ts');
const evidence = message => ({ id: 'failure', kind: 'assertion', runId: 'run', caseId: 'case', failureClass: 'failed', message });

test('missing generated actions fail explicitly and provide case-bound automation evidence', async () => {
  for (const kind of ['fill', 'click', 'upload', 'expect-visible']) {
    const source = generator.emitSpecFile('/', [{ id: 'case', name: 'Required action', steps: [{ kind, selector: '#fixture-control', value: 'private-input-canary', path: 'fixture.txt' }] }], { locatorStore: {} });
    const statement = source.match(/await Promise\.reject\(new Error\((.+)\)\);/);
    assert.ok(statement, `Missing ${kind} must not be silently skipped`);
    const message = JSON.parse(statement[1]);
    assert.equal(message.includes('private-input-canary'), false);
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    await assert.rejects(new AsyncFunction(statement[0])(), { message });
    assert.equal(analysis.analyzeWorkflowEvidence([evidence(`Error: ${message}`)]).verdict, 'automation-failure');
    assert.equal(analysis.analyzeWorkflowEvidence([evidence(`Error: ${message}`), { id: 'network', kind: 'network', runId: 'run', caseId: 'case', message: 'ECONNREFUSED' }]).verdict, 'unknown');
  }
});
test('missing completion text alone never authorizes a fabricated repair', () => {
  const message = 'Error: expect(locator).toBeVisible() failed\nLocator: getByText(/success/)\nError: element(s) not found';
  assert.equal(analysis.analyzeWorkflowEvidence([evidence(message)]).verdict, 'unknown');
  assert.equal(analysis.analyzeWorkflowEvidence([evidence('{"code":"GENERATED_LOCATOR_MISSING"}')]).verdict, 'unknown');
});
