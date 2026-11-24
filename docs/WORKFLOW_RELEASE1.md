# Unified Workflow Builder: Release 1 implementation report

**Acceptance update (2026-11-09): ACCEPTED for verified local Release 1 scope.** The independent
[Release 1 acceptance audit](WORKFLOW_RELEASE1_ACCEPTANCE.md) found and fixed
additional defects. The two-cycle targeted remediation passes all 23 artifact
confidentiality checks, with unsafe formats blocked. Generated tests now execute,
and explicit missing-action diagnostics support RCA and repair. Stale repair
requests now require fresh suite evidence. The controlled approved/rejected
chains, targeted rerun, final full suite and reporting pass; source-export
compatibility also passes. The Windows cancellation repair now terminates the owned
browser process tree. Live cancellation and full-chain retry both pass, with no
orphaned browsers, duplicate application side effects or incorrect terminal reports.
Use that report for the current readiness decision; the milestone counts below
describe implementation history, not final release acceptance.

Release 1 extends the existing workflow page, Operator/BullMQ workers, Prisma
records, API runner, Playwright generator, and reports. No deployment or production
configuration change was made. The migration was applied only to disposable test
databases; it has not been applied to the repository's configured database.

## Milestones and verification

Counts below are cumulative at each milestone, not numbers to add together.
The baseline was established before changing autonomous execution behavior.

| Milestone | Result | Verification at the milestone | Issues and next step |
| --- | --- | --- | --- |
| R1.0: autonomous baseline | Complete | 46 passing baseline/existing tests; four expected-failing quality-gate regressions recorded | Zero tests, hidden assertion failures, unexpected skips, and execution errors could falsely pass. Next: shared graph contracts. |
| R1.1: graph contracts | Complete | 36 contract tests passed | Persistence and runtime enforcement still pending. Next: enforce evidence gates in the actual autonomous worker. |
| R1.2: quality gates | Complete | 59 workflow tests and 34 existing tests passed; API typecheck passed | All four characterized false-success cases fixed. Added missing targeted/full-suite verification and autonomy checks. Next: durable graph execution. |
| R1.3: persistence and execution | Complete | 73 workflow tests passed; Prisma validation/generation and API typecheck passed | Database migration/restart integration was pending at this point; completed under R1.5. Next: reusable adapters and evidence. |
| R1.4: adapters, diagnosis and risk selection | Complete | 89 workflow tests passed; API typecheck passed | Conservative evidence classification and status-only API generation limits recorded below. Next: visual editing and debugging. |
| R1.5: editor, debugger and integrated verification | Complete locally | 101 workflow tests, 41 existing regression tests, browser smoke, disposable database/queue integration, API/web typechecks, and frontend build passed | Remaining limitations below. Next: review and acceptance of Release 1; Releases 2–4 remain unimplemented. |

Final workflow regression breakdown: 23 autonomous-worker tests, 36 contract tests,
17 adapter/evidence tests, 17 execution-engine tests, and eight version/API tests.
There are no failed, skipped, or TODO tests in those 101 cases.

The browser smoke uses the real compiled editor component in Chromium. It verifies
search/add, duplication/removal, undo/redo, configuration, autonomy selection,
save/reopen, templates, dragging, connecting execution ports, and removing edges.
It caught and led to a fix for connection selection/deletion. It is an isolated
component fixture; it does not exercise production authentication.

The integration test uses real Fastify routes, Prisma, PostgreSQL, BullMQ, Redis,
and the actual Operator worker. Authentication and external test adapters are
isolated. It verifies:

- Applying the additive migration to the pre-Release-1 schema preserves legacy
  workflows and historical runs.
- Saving versions/positions, tenant isolation, encrypted private state, and
  restart recovery without duplicate node records.
- Assertion failure remains workflow failure; editing a workflow leaves its
  previous version and run intact.
- Protected environments wait for approval. Approval uses the pinned reviewed
  version even after edits; simultaneous approvals dispatch once.
- Archive preserves history, and failed single-node diagnostics remain failures.

Temporary PostgreSQL and Redis containers are removed in the test's cleanup.
Neither integration nor baseline tests use the configured application database.

## What is available

The existing Workflows page now opens a React Flow editor for graph workflows.
Execution edges and typed data bindings are separate. Positions, configuration,
workflow variables, limits, and autonomy level are saved with immutable versions.
The palette provides Start, End, Condition, Merge, Assertions, HTTP Request,
Generate API Collection, Run API Collection, Discover UI, Generate UI Tests,
Run UI Suite, Autonomous QA, Select Tests by Risk, Analyze Failure Evidence,
Report/Quality Gate, and an Existing Workflow Action adapter.

Inputs support constants, workflow variables, environment values, scoped secret
references, and typed outputs from upstream nodes. Validation rejects cycles,
unreachable nodes, missing inputs, unsupported versions/configuration, invalid
schemas, and references unavailable on some execution paths. Bounded dataset
iteration belongs to Release 2; Release 1 accepts acyclic graphs only.

Use the API, UI, or autonomous template as a starting point. Select the project
and appropriate environment, configure required bindings, resolve validation
errors, and save before running. A protected environment still requires approval.
The run inspector shows node attempts, inputs/outputs, status, duration, errors,
assertions, evidence, available artifact downloads, existing result links, and a
JSON report export. A saved workflow can run an individual node with valid inputs,
optionally using recorded outputs from a compatible source run. A diagnostic
result is labeled `debug-completed`, never full-workflow success.

The worker saves encrypted private execution state and separately redacted public
results. It uses retained deterministic queue identifiers and child checkpoints.
Completed work is reused on resume. Ambiguous interrupted writes fail closed with
an unknown outcome; they are not automatically repeated. Safe retry is restricted
to failed pure/read/idempotent operations without already-executed descendants.
Cancellation, deadlines, execution counts, ownership, approval, and environment
fingerprints are checked during execution. Release 1 executes nodes sequentially,
within the configured maximum concurrency.

Quality gates independently evaluate test evidence. A nominally successful child
status cannot hide zero tests, failed assertions, errors, unknown result states,
unexpected skips, omitted required cases, failed repair, or failed targeted/full
verification. Branches deliberately not selected are recorded as such. A workflow
with no test/assertion evidence cannot report QA success.

| Autonomy level | Release 1 behavior |
| --- | --- |
| Assisted | User-started execution; no automatic repair. |
| Autonomous Testing | Bounded discovery/generation/testing without automatic repair. |
| Autonomous Recovery | Allows existing recovery only with supported automation-failure evidence and successful targeted/full verification. |
| Continuous QA | Recovery policy compatible with existing autonomous/scheduled execution. No new scheduler or continuous replanning is introduced. |

None of these levels grants authorization or bypasses security approvals. Existing
autonomous feature flags, security approval handling, and environment restrictions
remain in force. Existing jobs without a new autonomy setting retain their legacy
recovery default, subject to the corrected evidence gates.

The `risk.select` node calls the existing risk-ranking planner without changing its
scoring formula. It bounds workflow/test selection, preserves unrankable coverage,
and proposes route gaps. Its output can constrain UI generation or suite selection.
Cross-API, UI-journey, and AI-evaluation coverage intelligence is recorded in
[the roadmap](ROADMAP.md) for later releases.

## Files changed

Paths are repository-relative. Some files span multiple milestones.

### R1.0 and verification infrastructure

- `tests/workflows/operator-harness.mjs`
- `tests/workflows/autonomous-baseline.test.mjs`
- `tests/workflows/contracts.test.mjs`
- `tests/workflows/engine.test.mjs`
- `tests/workflows/adapters.test.mjs`
- `tests/workflows/routes.test.mjs`
- `tests/workflows/editor-fixture.tsx`
- `tests/workflows/editor-smoke.mjs`
- `tests/workflows/integration.mjs`
- `package.json`, `.gitignore`

### R1.1 shared contracts

- `packages/testmind-core/workflow/registry.js`
- `packages/testmind-core/workflow/validation.js`
- `packages/testmind-core/workflow/policy.js`
- `packages/testmind-core/workflow/quality.js`
- `packages/testmind-core/workflow/execution.js`
- `packages/testmind-core/workflow/index.js`
- `packages/testmind-core/workflow/index.d.ts`
- `packages/testmind-core/package.json`, `pnpm-lock.yaml`

### R1.2 autonomous gates

- `apps/api/src/runner/operator-worker.ts`
- `apps/api/src/routes/qaAgent.ts`

### R1.3 persistence, routes and execution

- `apps/api/prisma/schema.prisma`
- `apps/api/prisma/migrations/20261109120000_workflow_graph_foundation/migration.sql`
- `apps/api/src/lib/workflow-version.ts`
- `apps/api/src/lib/workflow-execution-policy.ts`
- `apps/api/src/routes/workflows.ts`
- `apps/api/src/routes/workflowGraphs.ts`
- `apps/api/src/routes/operator.ts`
- `apps/api/src/routes/secrets.ts`
- `apps/api/src/runner/workflow-engine.ts`
- `apps/api/src/runner/workflow-controls.ts`
- `apps/api/src/runner/workflow-runner.ts`
- `apps/api/src/runner/workflow-recovery.ts`
- `apps/api/src/runner/queue.ts`
- `apps/api/src/index.ts`

The secret update/delete change scopes mutations to the already-authorized project.
The Operator route excludes encrypted private task state from public responses.

### R1.4 existing runner adapters, risk and evidence

- `apps/api/src/runner/workflow-handlers.ts`
- `apps/api/src/runner/workflow-evidence-collector.ts`
- `apps/api/src/lib/workflow-evidence.ts`
- `apps/api/src/lib/workflow-risk.ts`
- `apps/api/src/lib/workflow-http.ts`
- `apps/api/src/runner/api-test-service.ts`
- `apps/api/src/runner/api-test-worker.ts`
- `apps/api/src/runner/worker.ts`
- `apps/api/src/runner/result-parsers.ts`
- `apps/api/src/testmind/discover.ts`
- `apps/api/src/testmind/pipeline/codegen.ts`
- `apps/api/src/testmind/adapters/playwright-ts/generator.ts`

### R1.5 visual editing and inspection

- `apps/web/src/pages/WorkflowsPage.tsx`
- `apps/web/src/components/workflows/WorkflowEditor.tsx`
- `apps/web/src/components/workflows/WorkflowRunInspector.tsx`
- `apps/web/src/components/workflows/graph-model.ts`
- `apps/web/src/components/workflows/workflow-editor.css`
- `apps/web/package.json`
- `docs/ROADMAP.md`, `docs/WORKFLOW_RELEASE1.md`

## Reproduce the checks

Use `pnpm.cmd` on Windows if PowerShell's execution policy blocks `pnpm.ps1`.

```powershell
pnpm.cmd test:workflows
node --import tsx --test apps/api/src/lib/security-approval-policy.test.ts apps/api/src/lib/autonomous-planner.test.ts apps/api/src/lib/investigator.test.ts apps/api/src/lib/safe-fetch.security.test.ts
pnpm.cmd exec tsc --noEmit -p apps/api/tsconfig.json
pnpm.cmd exec tsc --noEmit -p apps/web/tsconfig.json
pnpm.cmd --filter testmind-web exec vite build
pnpm.cmd test:workflow-editor
pnpm.cmd test:workflow-integration
```

The editor check requires the existing Playwright Chromium installation and an
available local port 5197. The integration check requires a local Docker daemon,
`postgres:16-alpine`, `redis:7`, the current generated Prisma client, and Git history
containing pre-Release-1 revision
`c696baa1f2ae8bc01f2ce0eed82c4e1c2299ab09`. It deliberately pins that schema instead
of reading HEAD, so the migration test remains meaningful after merging.

The frontend build succeeds with warnings about outdated Browserslist data and
large chunks. Dependency refresh and bundle splitting were not included in this
workflow release.

## Limitations and remaining acceptance work

- No production rollout is authorized or performed. Existing installations need
  the additive migration and current Prisma client before using graph persistence.
  Keep the existing encryption key stable so saved private state remains readable.
- Integration verifies local database/queue behavior and controls. It does not
  certify a deployed application, real identity provider, or arbitrary API/UI
  target. Target-specific authenticated workflow acceptance remains necessary.
- API generation uses supported OpenAPI endpoints and explicit success-status
  assertions. It does not generate full API contract tests, parameter fixtures,
  request bodies, or authentication flows. Configure these in the existing API
  collection editor. JSON Schema assertions now validate nested constraints and
  reject unsupported keywords visibly.
- Workflow API collections requiring an unsupported auth-session adapter fail
  explicitly. HTTP nodes support scoped bearer-secret references.
- Workflow HTTP and discovery validate destinations against existing safe-fetch
  policy; an environment restricts the target origin. Generated browser tests
  enforce the selected origin. Cross-origin authentication/CDN dependencies may
  therefore need future explicit allowlist support. Curated suites still use the
  existing trusted test-code execution model; this is not a new OS-level sandbox.
- Root-cause analysis correlates recorded run/case/request identifiers, assertions,
  API responses, network signals, available JSON/text backend-log attachments, and
  artifact references. Backend logs must actually be attached; no external log
  service is automatically connected. Trace ZIP contents and screenshot pixels
  are available for inspection but are not automatically interpreted. Conflicting
  or insufficient evidence remains unknown; a server error alone is not proof of
  an application defect.
- An interrupted inline write whose result was never recorded remains unknown.
  Automatic replay is deliberately unavailable; inspect the external effect before
  starting new work. Restart recovery is available for checkpointed child jobs.
- Python/pytest, dataset iteration, LLM/chatbot/RAG/Chroma nodes, expanded coverage
  intelligence, new CI/schedule integration, reusable subflows, and complex
  autonomous replanning remain Releases 2–4 work. They were not implemented.
