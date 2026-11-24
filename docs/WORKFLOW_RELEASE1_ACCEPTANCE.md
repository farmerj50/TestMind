# Release 1 acceptance audit and final hardening

Audit date: 2026-11-09. Scope: the existing Unified Workflow Builder and Autonomous
QA implementation, including final Release 1 hardening. No Release 2 work,
deployment, production configuration change, or production migration was performed.

## Executive decision

**Release 1: ACCEPTED for the verified local Release 1 scope.** Both remaining
lifecycle scenarios passed in one execution of the repaired fixture. This decision
uses the previously recorded passing chain, rejection, reporting, source-export,
confidentiality and regression evidence; those suites were not rerun.

Confirmed cause: Windows cancellation terminated the Playwright `.cmd` launcher
without terminating its descendants. The previous report recorded an actual
30,156 ms test timeout, rather than prompt browser cancellation. The focused change
in `apps/api/src/runner/node-test-exec.ts` terminates that launcher's process tree
with scoped `taskkill /PID ... /T /F`, waits for termination, and removes the abort
listener. Non-Windows cancellation and security policies are unchanged.

Commands/results:

- `pnpm.cmd exec tsc --noEmit -p apps/api/tsconfig.json`: PASS.
- `node --check .tmp/lifecycle-acceptance.mjs`: PASS.
- `node .tmp/lifecycle-acceptance.mjs`: PASS, exit 0; one cancellation attempt,
  then one retry scenario. The 20-second cancellation limit was unchanged.
- `git -c core.safecrlf=false diff --check -- apps/api/src/runner/node-test-exec.ts`: PASS.
- `docker ps --filter label=testmind.workflow.test --format '{{.Names}}'`: empty.

Cancellation run `cmw9loz1e00077kh8wgk0qhhm`: shutdown, three seconds of stable
heartbeats and the process check completed in **7,137 ms**. No browser processes
remained, including previously observed process identities after reparenting.
No downstream continuation occurred; parent workflow/operator statuses were canceled,
the node reported `failureKind=canceled`, and resume was rejected. Child
`wf-ui-cmw9loziy000d7kh8l59t36ue` used the existing terminal representation
`failed` with `Canceled by user`; it was not reported as successful.

Retry run `cmw9lp90v000l7kh8qhv73iku`: actual discovery, generation and browser
execution preceded one injected recoverable evidence-read outage. The authorized
retry retained failed attempt 1 and successful attempt 2. Completed stage IDs were
preserved, application side effects remained **2 before / 2 after**, the final
quality gate and report passed, and no browser processes remained.

Evidence: `tests/workflows/.scratch/lifecycle/{results.json,workers.log}`,
`tests/workflows/.scratch/lifecycle-fix-{types,live}.log`. Changed files: the runner
file above, ignored lifecycle fixture/evidence and these two Release 1 reports.
No remaining blocker for this acceptance scope. Production deployment/rehearsal
limitations below remain operational follow-ups, not claims of production testing.
No deployment, production configuration changes, push, merge or Release 2 work.

### Historical: preceding cancellation verification failure

**Latest verification-only attempt: NOT ACCEPTED.** Live browser cancellation
verification **FAIL**; full-chain retry **NOT RUN**, because the requested stop-on-
failure limit was reached. No application or security code was changed.

Command: `node .tmp/lifecycle-acceptance.mjs` (one execution; nonzero exit).
The ignored fixture reused disposable PostgreSQL/Redis, actual workflow routes,
Operator/UI workers, and Chromium. It observed at least three browser heartbeats
and an open event stream before the cancel API returned 200. The combined check
for stream closure and a terminal child-run status did not pass within 20 seconds.
This establishes a cancellation verification timeout; it does not establish which
of those conditions remained outstanding. A later worker completion appeared
during cleanup, after the scenario had failed, and was not counted as a pass.
No second attempt or repair was made. The parent removed its disposable services;
`docker ps --filter label=testmind.workflow.test --format '{{.Names}}'` was empty.

Evidence: `tests/workflows/.scratch/lifecycle/{results.json,workers.log}` and
`tests/workflows/.scratch/final-lifecycle.log`. Child run:
`wf-ui-cmw9l7d83000d7k10unj1jxeo`. Prior approved/rejected-chain, source-export and
23 confidentiality results are unchanged. Current changes are limited to the
ignored verification fixture/evidence and these acceptance reports. No deployment,
push, merge, production configuration change or Release 2 work occurred.

### Historical: preceding stale-repair verification

**Latest bounded attempt: autonomous chain PASS, rejection PASS, final execution
PASS. Release 1 remains NOT ACCEPTED pending the previously required live browser
cancellation and full-chain retry verification.** Those scenarios were not run in
this one-fix attempt; no untested scenario is marked passed.

The stale request was an actual worker defect, exposed by a fixture patch that
fixed two tests in one file. The worker reused failures from the original run.
After successful targeted verification it now runs the full suite before any
further proposal. Only still-failing, previously pending cases may continue, using
their fresh run/results and fresh RCA. Missing/skipped cases, newly introduced
failures and failed repairs remain blocking. Stale protection was not bypassed.

One fix/verification cycle, local only:

- `node --test --test-name-pattern='repair|verification|quality gate|stale' tests/workflows/autonomous-baseline.test.mjs tests/workflows/targeted-remediation.test.mjs`: **25/25 PASS**.
- `pnpm.cmd exec tsc --noEmit -p apps/api/tsconfig.json`: **PASS**.
- `node tests/workflows/integration.mjs --final-only --chain-only`: **PASS**, exit 0.
- `docker ps --filter label=testmind.workflow.test --format '{{.Names}}'`: empty; disposable services cleaned up.

Approved job `cmw9kvvy000017kmsk8g2ylq0` completed discovery, generation, initial
failure, RCA, one proposal/approval, targeted re-execution and full-suite execution.
Targeted run `cmw9kwc0d001p7kmsjlx3oq0a` passed its required test; final run
`cmw9kwj3b001y7kmsk6pzv15w` passed all three tests with no skips. No second stale
proposal occurred. Reported task statuses, linked runs and repair counts matched
the recorded history and the final quality gate passed.

Rejected job `cmw9kwqn8002b7kmshuo5nuov` had two denied proposals. Each original
source hash remained unchanged; no repair succeeded and no targeted repaired-code
execution occurred. Only the authorized initial and final runs of unchanged tests
executed, both failed, and the job/report correctly stayed failed. Foreign approval
attempts returned 403 and repeated decisions returned 409.

Evidence: `tests/workflows/.scratch/final-stale-{tests,types,chain}.log` and
`tests/workflows/.scratch/final/{results.json,chain-result.json,chain.log}`.
Changed: `apps/api/src/runner/operator-worker.ts`,
`tests/workflows/{autonomous-baseline.test.mjs,final-acceptance.mjs}` and both
Release 1 reports. Artifact confidentiality code and the 23 passing checks are
unchanged; they were not rerun. No full regression run, production changes,
deployment, push, merge or Release 2 work. Stopped after the authorized attempt.

### Historical: preceding RCA/source-export fix

**Final targeted fix: NOT ACCEPTED.** Source export is **PASS**; the complete
autonomous chain remains **FAIL**. Artifact download security code and the existing
23 passing confidentiality checks were unchanged and were not rerun.

The generator previously emitted comments instead of required actions when shared
locators were absent. Later missing-text assertions could not prove that cause.
It now emits a structured missing-action error without input values; RCA recognizes
that explicit diagnostic, while ambiguous assertions and conflicting evidence stay
unknown. The source-export test now supplies its required project-secret lookup;
all original confidentiality and successful-export assertions are retained.

Commands in this bounded follow-up:

- `node --test --test-name-pattern='missing generated|missing completion|evidence:|correlation can|generated file, bundle' tests/workflows/final-blockers.test.mjs tests/workflows/adapters.test.mjs tests/workflows/trace-security.test.mjs`: **12/12 PASS**.
- `pnpm.cmd exec tsc --noEmit -p apps/api/tsconfig.json`: **PASS**.
- `node tests/workflows/integration.mjs --final-only --chain-only`: **BLOCKED**, nonzero exit.

Live evidence: initial run `cmw9klg16000h7kk4r2l1upnp` reached self-heal; attempt
`cmw9klszv001j7kk4qiaeda2x` succeeded, and targeted rerun
`cmw9klwyr001p7kk4ylm0cuxh` exited 0. The deterministic provider fixture repaired
multiple missing actions in the same file. The next repair request still referred
to another original failure, but that file no longer contained missing-action
diagnostics. The fixture refused to invent another patch and its assertion stopped
the child process. Rejection, final full-suite verification and the complete chain
are not passed. No second application fix was attempted.

Evidence: `tests/workflows/.scratch/final-blockers-{tests,types,chain}.log` and
`tests/workflows/.scratch/final/{chain.log,chain-result.json,results.json}`.
Changed: `apps/api/src/lib/workflow-evidence.ts`,
`apps/api/src/testmind/adapters/playwright-ts/generator.ts`,
`tests/workflows/{final-blockers.test.mjs,trace-security.test.mjs,final-acceptance.mjs}`,
and the two Release 1 reports. The fixture's invalid-form message is emitted only
on an actual validation event; test assertions were not weakened. No deployment,
production configuration change, push, merge or Release 2 work occurred.

### Historical: preceding two-cycle remediation

**Targeted remediation, final decision: NOT ACCEPTED.** Two repair/test cycles
are complete. Artifact confidentiality is **23/23 PASS**. The autonomous chain
is **FAIL**: generated tests now execute, but repair/approval/re-execution remains
unverified. No third repair cycle was started.

### Current commands and evidence (supersedes the historical results below)

| Actual command | Result |
|---|---|
| `node --test tests/workflows/targeted-remediation.test.mjs tests/workflows/repair-safety.test.mjs` | Cycle 1: 15/15 PASS |
| `pnpm.cmd exec tsc --noEmit -p apps/api/tsconfig.json` | PASS in both cycles |
| `node tests/workflows/integration.mjs --final-only` | Cycle 1: disposable Prisma setup timed out; no live chain result |
| `node .tmp/run-artifact-acceptance.mjs` | Cycle 1 independent confidentiality pass: 23/23 PASS |
| `node --test tests/workflows/targeted-remediation.test.mjs tests/workflows/repair-safety.test.mjs tests/workflows/trace-security.test.mjs` | Cycle 2: 42/43 PASS; one source-export compatibility assertion failed |
| `node tests/workflows/integration.mjs --final-only` | Cycle 2: chain FAIL, confidentiality 23/23 PASS; nonzero exit |

The final live command internally ran `node tests/workflows/trace-live.mjs`:
real trace capture, sanitized download and installed Playwright Trace Viewer passed.
The existing 220-test aggregate was not rerun. Only directly affected trace/security
tests were included. Web typecheck/build results below remain historical.
Disposable test containers were removed, verified with
`docker ps --filter label=testmind.workflow.test --format '{{.Names}}'` (empty).

Current evidence: `tests/workflows/.scratch/targeted-cycle{1,2}-*.log`,
`tests/workflows/.scratch/final/results.json`, `chain-result.json`, `chain.log`,
and `artifact-cycle1.json`. These files are local, ignored test evidence.

### Current autonomous-chain evidence and blockers

Actual job `cmw9kbxu800017ktg4ru7qi3x`, run `cmw9kc04a000h7ktglp77wiii`,
used disposable PostgreSQL/Redis, actual Operator/UI/self-heal workers and a
controlled loopback application. Discovery and generated-file validation passed.
Moving generated files outside hidden directories resolved Playwright collection:
three tests executed, one passed and two failed assertions. Generated source
contains missing-locator comments for the email field and submit button; the
expected completion/validation text was absent. RCA returned `unknown` and the
existing evidence gate correctly stopped recovery for human intervention, even
though the legacy classifier suggested self-healing. No repair or approval was
created. No successful repair, rejection, re-execution, final successful report,
full-chain cancellation or execution retry is claimed.

The new proposal gate and classification tests passed, including denied, expired,
canceled, foreign-owner and changed-source cases. These are targeted tests, not
substitutes for the blocked full chain. The local deterministic repair-provider
fixture was configured but never reached.

One additional regression remains unresolved: `trace-security.test.mjs:176`
expects a safe generated-source bundle to return 200 but receives 422. Its Prisma
fixture does not provide the newly required project-secret lookup. Safe export
compatibility has therefore not passed verification; the assertion was retained.

### Current artifact-confidentiality matrix

| Format / route | Checks | Verified result |
|---|---:|---|
| Trace and actual Trace Viewer | 1 | PASS: sanitized, readable |
| PNG and WebM | 2 | PASS: explicit HTTP 422 |
| HTML aliases | 3 | PASS: explicit HTTP 422 |
| Allure aliases/assets | 4 | PASS: explicit HTTP 422 |
| Execution-log aliases | 3 | PASS: explicit HTTP 422 |
| Error-JSON aliases | 3 | PASS: HTTP 200, sensitive content withheld |
| Generated-source/file and archive aliases | 3 | PASS: secret-bearing exports rejected |
| Unsupported format, unscoped report, private original | 3 | PASS: blocked |
| Foreign ownership across exercised routes | 1 aggregate | PASS: denied |
| **Total** | **23** | **23 PASS** |

Unsafe media, active report documents and free-form logs fail closed through the
central artifact gateway; originals remain untouched. JSON downloads use a
structured allowlist projection. Source exports require project scope and reject
detected project secrets, common encodings and credential literals before streaming.
Unscoped debug previews and the legacy human HTML view are blocked; targeted
authorization tests pass. Supported trace sanitization and private derivative
storage remain intact. Generic arbitrary source literals are not proven secret-free
by these fixtures; source-export verification remains a release limitation.

Changed files in this remediation: `.gitignore`;
`apps/api/src/ai/core/{repair-approval,repair-service}.ts`;
`apps/api/src/lib/{artifact-service,source-export}.ts`;
`apps/api/src/routes/{artifacts,operator,run}.ts`;
`apps/api/src/runner/operator-worker.ts`; `apps/api/src/testmind/routes.ts`;
`tests/workflows/{final-acceptance.mjs,targeted-remediation.test.mjs,repair-safety.test.mjs,trace-security.test.mjs}`;
this report and `docs/WORKFLOW_RELEASE1.md`. Local ignored fixture scripts/evidence
were also created. No production configuration, deployment, push, merge or Release 2
work occurred. Remaining blockers require a separately authorized follow-up beyond
the completed two-cycle limit.

### Historical: previous bounded verification

**Latest targeted verification: NOT ACCEPTED.** The two outstanding checks were
attempted under the requested one-pass/one-focused-correction limit. Non-trace
artifact confidentiality now has confirmed failures (18 failed checks across
23 format/route checks). The actual autonomous workers reached discovery,
generation, execution and triage, but the fixture's hidden output directory was
excluded by the runner's Playwright configuration. No full repair/approval/
re-execution chain was verified. The 220 previously passing regressions below
were deliberately not rerun; their counts are historical evidence.

### Final targeted pass: commands and evidence

```powershell
node tests/workflows/integration.mjs --final-only
node tests/workflows/integration.mjs --final-only --chain-only
```

The first command ran both outstanding checks, exited 2, and reused the existing
disposable Docker lifecycle and artifact harness. The chain child initially
stopped because its synthetic encryption key used hex rather than required base64.
The single focused correction changed that fixture encoding. A shell edit failed
before applying it; the chain-only command therefore had one additional setup-only
failure before the corrected invocation. The corrected chain-only invocation
exited 2. No application code or security policy was changed to obtain a pass.

The artifact pass internally ran the existing `node tests/workflows/trace-live.mjs`
against its loopback fixture. It passed, including all eleven credential categories,
unchanged originals, every-member inspection and the installed Trace Viewer. No
220-test regression rerun, frontend build, deployment, push or merge was performed
in this final targeted pass.

Evidence is local and ignored by Git:

- `tests/workflows/.scratch/final/results.json`: combined chain and 23-row artifact matrix.
- `tests/workflows/.scratch/final/chain-result.json`: persisted task/run outputs and classifications.
- `tests/workflows/.scratch/final/chain.log`: actual worker/Playwright execution log.
- `tests/workflows/.scratch/final-verification.log`, `final-chain-retest.log`: command results.
- `tests/workflows/.scratch/final/runner-logs/`: real worker evidence and synthetic artifact fixtures.
- `tests/workflows/.scratch/trace-live/trace-viewer.png`: passing trace-viewer evidence from this pass.

### Autonomous-chain result: incomplete, not accepted

This pass imported the actual Operator, UI and self-heal workers, Prisma client,
queue module, discovery/generation and execution code in a separate process with
disposable PostgreSQL/Redis. It did not replace these stages with unit-test stubs.
The target was a loopback application; environment credentials were synthetic,
GitHub writeback was disabled, and any LLM endpoint was constrained to a non-listening
loopback address. No external LLM completion was exercised. Authentication/provider
deployment acceptance was not implied.

Observed job `cmw9jganb00017k4ka7cwmpm8` and test run
`cmw9jgcdl000h7k4kdue1qtrf` reached these stages:

| Stage | Actual observation | Result |
|---|---|---|
| Discovery | One reachable route; real browser scan and project context persisted | PASS for exercised local target |
| Generation | Three test cases reported; generated-path validation found one spec file | PASS for file creation; generated execution not established |
| Execution | Actual UI worker/Playwright reported `No tests found` | BLOCKED by fixture placement |
| Failure analysis | Evidence analyzer returned `unknown`; legacy classifier labeled the runner failure `defect` | FAIL: runner failure must not be presented as an application defect |
| Repair proposal/approval/application | Zero healing attempts and zero approval records | NOT REACHED |
| Approved/rejected repair source behavior | No approved or denied repair reached | NOT VERIFIED |
| Targeted/full-suite re-execution and repair history | No repair verification runs | NOT VERIFIED |
| Stage-by-stage cancellation, retries and side effects | No full-chain exercise reached these checkpoints | NOT VERIFIED; prior isolated regressions are not a substitute |
| Final QA verdict | Failed execution stayed failed; no false success was reported | PASS for this observed failure |

The fixture used `.tmp/final-generated`; the existing runner config ignores
`**/.*/**`. This is a harness-placement problem, not proof that ordinary visible
generated directories fail. The discovery output also called its count
`specFileCount: 3` while validation found one file; retain that discrepancy for
review rather than silently treating the counts as interchangeable. A new
chain-only run with a visible isolated generated directory is needed before
claiming generated execution, repair, approval, cancellation, or retry acceptance.
That additional correction/run was not made after the requested limit was reached.

Source inspection also found that the autonomous self-heal path authorizes repair
and persists the result directly; no repair-proposal approval node is registered.
This is a design concern, not a demonstrated approval bypass in this live run:
the run never reached repair. A workflow-start approval does not by itself prove
the requested proposal → approve/deny → apply semantics.

### Artifact-confidentiality matrix: confirmed failures

The tests rendered synthetic sensitive data in a real browser for PNG/WebM,
created representative HTML/Allure/log/error/source fixtures, and requested them
through the actual Fastify handlers. Ownership/secret lookups were isolated test
dependencies. HTML/Allure checks used canary-bearing fixture content of the served
formats, not a claim that an entire Allure generator was exercised. Expected
outcomes were sanitized supported content or an explicit security rejection.
Known project secrets and additional runtime sensitive values were distinct.
No canary values are printed in the generated acceptance matrix.

| Format / route | Checks | Actual result | Acceptance |
|---|---:|---|---|
| Playwright trace + actual Trace Viewer | 1 | Existing live recorder/download/viewer fixture passed | PASS |
| Screenshot PNG | 1 | HTTP 200, byte-identical to original screenshot of sensitive fixture text | FAIL |
| Video WebM | 1 | HTTP 200, byte-identical to original recording made while sensitive text was displayed; no sanitization | FAIL |
| HTML report, three runner aliases | 3 | HTTP 200 with runtime sensitive value intact | FAIL |
| Allure HTML, three runner aliases plus `/assets/*` | 4 | HTTP 200 with runtime sensitive value intact | FAIL |
| Execution text log, three aliases | 3 | Known bearer value redacted, additional runtime sensitive value survives | FAIL |
| Error JSON, three aliases | 3 | Sensitive key redacted, sensitive free-form error message survives | FAIL |
| Generated source preview `/tm/generated/file` | 1 | HTTP 200 contains known project secret in source fixture | FAIL |
| Generated archives `/tm/generated/download`, `/tm/download` | 2 | Known project secret remains inside an archive member | FAIL |
| Unsupported opaque format | 1 | HTTP 422 | PASS |
| Unscoped raw Playwright report route | 1 | HTTP 422 | PASS |
| Private-original path reference | 1 | HTTP 422 | PASS |
| Ownership across every exercised download route | 1 aggregate | Foreign owner receives HTTP 404 | PASS |
| **Total** | **23** | **5 passed, 18 failed** | **NOT ACCEPTED** |

Byte identity is direct evidence that the media gateway performs no redaction.
This pass did not add OCR or claim pixel-level sanitization. The trace safety
policy remains effective, but it cannot establish confidentiality for separate
images, videos, report assets, free-form logs/errors or exported test source.
Ownership checks passing does not waive the owner-download confidentiality requirement.

### Files changed and remaining decisions for this pass

- `tests/workflows/integration.mjs`: targeted `--final-only` dispatch, preserving the existing test mode.
- `tests/workflows/final-acceptance.mjs`: disposable real-worker chain harness and bounded result capture.
- `tests/workflows/final-artifacts.mjs`: supported-format/route canary matrix and existing live trace reuse.
- `docs/WORKFLOW_RELEASE1_ACCEPTANCE.md`, `docs/WORKFLOW_RELEASE1.md`: current findings and decision.

No application implementation or production configuration changed in this pass.
The fixture key correction is the focused repair attempt; artifact remediation
was not started. Remaining blockers are (1) an unverified full chain and repair
approval/rejection semantics, (2) observed runner-failure misclassification, and
(3) confirmed non-trace artifact/source confidentiality failures. Further work
requires deciding to extend the bounded verification run and choosing masking/
sanitization versus explicit download blocking for unsafe non-trace formats.
Release 1 remains **NOT ACCEPTED**. Release 2 remains unstarted.

### Previous trace-remediation result (historical)

**NOT ACCEPTED overall. SEC-ARTIFACT is remediated for supported downloadable
Playwright traces.** Separate validated derivatives replace raw downloads; unsafe
or unsupported inputs receive an explicit security error. The original credential
exposure probe now passes, and a separate live recorder/Trace Viewer test verifies
eleven credential categories, unchanged originals, and usable sanitized evidence.
This closes the confirmed trace defect without treating unverified mandatory
Release 1 criteria as passed.

The final automated regression suites pass: **142 workflow tests (including 27
trace-security tests) and 78 selected existing tests**, without failures, skips,
or TODOs. API/web TypeScript checks, the frontend production build, and editor
interactions pass. Earlier replay, cancellation, repair-authorization,
assertion-preservation, and editor fixes remain covered. The trace check still
fails if a credential survives; its assertion was corrected to require the safe
behavior, not bypassed.

Real local PostgreSQL, Redis, BullMQ, Fastify, HTTP, Chromium, discovery, generation,
and Playwright CLI checks support substantial portions of Release 1. They do not
certify a deployed identity provider, hard process termination at every durability
boundary, or the entire autonomous repair pipeline against a real application.
These boundaries are marked PARTIAL or NOT TESTED below.

This report supersedes any interpretation of [WORKFLOW_RELEASE1.md](WORKFLOW_RELEASE1.md)
as release acceptance. That document remains the implementation milestone record.

## Evidence definitions

- **W**: `pnpm.cmd test:workflows`, 142 tests. Actual source modules loaded with
  isolated dependencies; this is not a live deployment. Includes 23 autonomous
  baseline, 36 contract, 21 engine, 19 adapter, 8 route, 8 repair-safety, and 27
  trace-security tests.
- **E**: 78 selected existing tests covering approval policy, planner, investigator,
  outbound URL policy, repair policy/executor, locator store, generated specs, and
  Operator decisions. Includes the new assertion-intent regressions.
- **I**: `tests/workflows/integration.mjs`, five foundation scenarios with real
  disposable PostgreSQL 16, Redis 7, Prisma, BullMQ, Fastify, and the Operator
  worker. Identity and external adapters are injected test dependencies.
- **A**: `tests/workflows/acceptance-scenarios.mjs`, additional real local HTTP/API,
  queue, recovery, cancellation, security, browser, and artifact checks. Fault
  injection is explicitly identified; injected states are not OS process kills.
- **B**: actual Chromium interactions in `editor-smoke.mjs` and
  `acceptance-browser.mjs`. The latter compiles the actual Workflows page, `useApi`,
  editor, and inspector and sends workflow requests to the real Fastify routes.
  Clerk is replaced by a test identity adapter. Auxiliary project/environment
  lists are test adapters; workflow persistence/execution are real.
- **U**: `acceptance-ui.mjs`, actual discovery and existing generation followed by
  Playwright CLI against a local fixture. Parses the actual report and calls the
  actual evidence collector; the harness persists parsed results. This is **not**
  a full end-to-end run through the existing UI worker.
- **S**: `trace-security.test.mjs`, actual archive/sanitizer/service and Fastify
  artifact, export, and diagnostic handlers with isolated ownership/storage
  dependencies. Tests malformed data, authorization, aliases, concurrent downloads,
  historical references, source exports, capture policy, and fail-closed behavior.
- **V**: `trace-live.mjs`, actual installed Playwright 1.58.2 recorder and Trace
  Viewer in Chromium against a synthetic loopback target. Downloads through the
  actual artifact gateway, checks every archive member, and opens the sanitized
  actions, DOM snapshot, network table, and failed-action error in the viewer.

PASS applies to the stated bounded requirement and evidence, not to every possible
target application or operational failure mode. PARTIAL means some required
behavior or end-to-end evidence is still missing.

## Requirements matrix

| Requirement | Status | Evidence | Test Result | Remaining Issue |
|---|---|---|---|---|
| Open builder; find and add nodes | PASS | B: actual editor and Workflows page | Browser interaction passed | No deployed identity-provider certification |
| Drag/reposition; duplicate/delete nodes | PASS | B: component interaction and graph state assertions | Passed | None in exercised desktop flow |
| Connect compatible ports; reject incompatible types | PASS | B: pointer connections; W contracts | Passed | Invalid execution graphs still require server validation |
| Remove connections; undo/redo | PASS | B: connection selection/removal and history | Passed | Undo history is session-local |
| Zoom/pan/Fit View | PASS | B: viewport changes | Passed | Test waits for rendering before pointer coordinates are measured |
| Configure inputs, environment and secret references | PASS | B; A authenticated HTTP | Saved references survive reopen; secret injected at runtime | No plaintext secret is required in the graph |
| Save/reopen/edit without configuration/layout loss | PASS | B actual backend; I version records | Passed | Fixed controlled-node measurements lost on unrelated form renders |
| Execute and display node results | PASS | B; I/A real BullMQ | Successful and failed execution records inspected | Transient states are polled, not streamed |
| Inspect outputs/failures/logs/artifacts through the whole UI | PARTIAL | B inspector; U artifact collection; S/V sanitized download and Trace Viewer | Outputs, failures and sanitized trace inspection exercised | Not every log/artifact interaction in the TestMind UI exercised |
| Version/run association and preservation after editing | PASS | I: edit after run and after approval request | Old run and approval retain original version | Immutability is enforced by application API, not a SQL UPDATE-denial trigger |
| Typed inputs/outputs and graph validation | PASS | W contracts/engine | Invalid schemas, cycles, missing inputs/references rejected | Release 1 accepts acyclic graphs only |
| Branches, merges and dependency ordering | PASS | W engine/contracts | Selected/unselected branches, merge activation, dominating references tested | Sequential nodes; no parallel-branch throughput certification |
| Durable per-node records, encrypted private state | PASS | I actual DB; W engine | Unique attempts and encrypted checkpoints preserved | Encryption key must remain available and stable |
| Safe retry and retained attempt history | PASS | W routes/engine; A failed assertion retried | Two attempts retained; unchanged failing assertion remains failed | Ambiguous writes and unsafe descendants cannot be replayed |
| Cancellation reaches running inline HTTP | PASS | A real slow HTTP; W engine | Node terminal failure kind is canceled; root stays canceled | UI subprocess cancellation has regression coverage, not a live kill test here |
| Timeout versus assertion/infrastructure/canceled/unknown outcomes | PASS | W engine; A real HTTP timeout/503/ambiguous write | Failure kind or unknown outcome retained | Task enum is still `failed`; consumers must read failure metadata |
| Completed execution cannot imply successful tests | PASS | W quality gates and real Operator baseline; I/A assertions | Zero tests, hidden assertions, unexpected skips/errors cannot pass | Child execution status and workflow QA verdict remain separate |
| Graceful worker restart/resume | PASS | I closes and recreates actual worker on retained state | No duplicate node records; graph completes | Does not simulate forced termination during an in-flight external operation |
| Before/after queue-dispatch crash recovery | PARTIAL | A throws at dispatch boundaries, then real reconciler/DB/queue | Both injected failures recover without duplicate nodes | Not an OS-kill test |
| External write before result persistence | PARTIAL | A performs real local POST then injects interrupted durable state | Unknown outcome fails; POST is not replayed | Persistence-boundary simulation, not abrupt process death |
| Duplicate delivery and concurrent workflows | PASS | A retained-ID and explicit completed redelivery; W atomic claim/UI callback | Independent concurrent graphs; no repeated API requests | Stalled claimed UI child intentionally does not restart external work |
| Full Redis/Postgres outage and hard-kill recovery certification | NOT TESTED | No such claim made | Not run | Separate failure-injection campaign needed |
| History and archive preservation | PASS | I; W routes | Runs/versions retained after archive and edits | Archived workflows have no dedicated UI archive index |
| Autonomous node and existing Operator compatibility | PASS | Registry/templates; W actual Operator module and legacy dispatch | Existing sequence/checkpoint regressions pass | Full live autonomous chain remains PARTIAL below |
| Discovery → generation → execution → classification → repair → targeted/full verification, all live | PARTIAL | W actual worker with mocked adapters; U real discovery/generation/CLI; E repairs | Individual stages and orchestration gates pass | No single live end-to-end autonomous repair exercise in this audit |
| Assisted/Autonomous Testing prohibit automatic repair | PASS | W baseline and repair-safety | Forbidden repairs rejected before execution/persistence | Existing non-graph jobs retain legacy defaults |
| Autonomous Recovery/Continuous QA retain approvals and limits | PASS | W policy, baseline and repair-safety; I protected environment | Allowed recovery remains bounded; changed authorization blocks repair | Continuous QA is policy/legacy schedule compatibility, not a new scheduler |
| Application defects remain failed; unsupported diagnosis stays unknown | PASS | W evidence/adapters; E investigator | No automatic conversion of application/unknown failures into success | Classification is deliberately conservative |
| Preserve assertions and test intent during repairs | PARTIAL | E AST-policy tests; W action/persistence paths | Removal, changed matcher/expected value/actual source, lost await, bypass/catch changes rejected; locator repair allowed | Bounded static guard is not a proof of arbitrary JS semantic equivalence |
| Required targeted and full verification cannot be skipped/overridden | PASS | W autonomous baseline/quality | Failed targeted pass remains failure even if full suite passes; missing cases rejected | Live full-chain evidence remains outstanding |
| OpenAPI import/generation/execution/persistence | PASS | A real generated collection through API BullMQ worker | Generated status assertion and persisted passing result | Limited endpoint/status generation; not comprehensive contract generation |
| API authentication, HTTP errors and report evidence | PASS | A real bearer target, HTTP 503, redacted inspector JSON | Correct auth works; error/assertion remains failed | Unsupported auth-session adapters fail explicitly; complex auth not certified |
| UI discovery/generation/screenshots/traces | PASS | U real local Chromium and Playwright CLI | Generated cases pass; screenshots/traces collected and associated | Simple local target, not arbitrary authenticated UI |
| Existing UI worker reuse, repair and verification | PARTIAL | Source adapters; W actual worker redelivery and Operator tests | Reuse and replay guard verified | Entire worker path with real browser, repair, targeted/full suite not exercised together |
| RCA correlation across cases, network, API, assertions and backend logs | PARTIAL | W evidence collector/classifier; U actual artifact association | Structured correlations and conservative classifications pass | No screenshot pixel analysis, trace-content interpretation, or automatic backend-log integration |
| Bounded existing risk planner connected to registry | PASS | W adapter tests; E planner | Risk selection/generation bounded; existing formula preserved | Expanded API/journey/AI coverage intelligence deferred |
| Cross-project workflow/version/run/attempt/retry/resume restrictions | PASS | W routes and A real Fastify/DB requests | Unauthorized access returns 404; mutations rejected | Real Clerk integration not exercised |
| Artifact ownership/path restrictions | PASS | S actual routes; U actual database ownership checks | Owner receives sanitized trace; foreign owner denied; job/run project binding and realpath checks enforced | Deployed Clerk and host ACL configuration not certified |
| Runtime secrets absent from JSON logs/debug/export fields | PARTIAL | W redaction regressions; A authenticated response reflection; B report export | Tested aliases, bearer values and nested report fields redacted | Not a proof for every legacy log channel or unknown encoding |
| Runtime secrets absent from supported downloadable Playwright traces | PASS | S/U/V; structured projection and every-member canary checks | Original contains credentials; separate downloadable trace does not; viewer opens it | Version 8 only; payload/source/image details deliberately withheld; unsupported inputs blocked |
| Runtime secrets absent from every other execution artifact | PARTIAL | Existing JSON redaction; traces now covered by S/U/V | Tested structured exports pass | Standalone screenshot/video pixels and all legacy log encodings are not certified secret-free |
| Environment approval and unsafe retry enforcement | PASS | I racing approval requests; W policy/routes; A retry | Reviewed version dispatched once; prohibited replay rejected | Existing approved environment policy remains authoritative |
| Outbound URL restrictions | PARTIAL | A actual safe-fetch/HTTP policy; E security tests | File URLs, cross-origin and private addresses rejected by default | No DNS-rebinding/socket pinning or arbitrary curated-code sandbox certification |
| Legacy configuration, historical runs and workflow approvals survive migration | PASS | I pre-R1 schema with populated legacy records | Config JSON and pending/resolved workflow approval fields preserved | Not a production-scale migration/lock-duration test |
| Legacy configurations remain executable | PARTIAL | W real Operator legacy branch and adapter regression | Legacy dispatch preserved | No full live historical suite execution after migration |
| Migration constraints/indexes and rollback review | PASS | Actual SQL review and I application | Additive columns/table/indexes; uniqueness and foreign keys in use | Operational rollout/rollback still requires approval and rehearsal |
| API/web typecheck and frontend production build | PASS | Final commands below | Exit 0 | Nonblocking bundle/Browserslist warnings retained |
| Browser identity, deployed routing and production target acceptance | NOT TESTED | Explicitly outside local fixture evidence | Not run | Required before claiming deployed acceptance |

## Confirmed capabilities and limits

The implementation provides a React Flow node palette, execution edges and typed
data bindings, reusable API/UI/Operator adapters, immutable-by-API version snapshots,
per-node attempts, approval-bound execution, safe retry/resume controls, and a run
inspector with JSON exports. HTTP/API execution, generated Playwright tests, result
parsing, and actual evidence attachment were exercised locally.

The four autonomy modes do not grant permissions. Revalidation now occurs before
repair execution and before persistence. Legacy Operator behavior remains subject
to the corrected evidence quality gates. Success requires actual passing test or
assertion evidence, not merely a completed child job.

Risk selection uses the existing planner and bounded selections. Python/pytest,
LLM/chatbot/RAG/Chroma nodes, richer coverage intelligence, dataset loops, subflows,
new schedule/CI integrations, and complex replanning remain deferred. None was
implemented during this audit.

## Defects and hardening applied

| ID | Severity | Confirmed problem | Fix and regression evidence | State |
|---|---|---|---|---|
| REPLAY-CHILD | P0 | Workflow UI redelivery could re-enter external test execution; API claim was not atomic and completed replay could corrupt status | Atomic queued-to-running claim shared by UI/API; completed delivery returns without re-execution. W actual UI callback/claim tests and A real API replay | Fixed |
| CANCEL-INLINE | P1 | Canceling an inline request did not interrupt it and could leave running node evidence | Abort propagation and deadline signal; active task cancellation evidence; periodic API authorization watcher. W and A slow local HTTP/cancel/timeout | Fixed |
| SECRET-JSON | P0 | Header aliases and reflected bearer values could survive structured redaction | Expanded aliases/known bearer handling; redacted API response headers, versions and inspector response. W and A canary checks | Fixed for tested surfaces; artifact issue separate |
| REPAIR-INTENT | P0 | A repair could remove/weaken assertions or make them unreachable while preserving the test title | AST guard covers matcher, expected/actual structure, await, local initializers and control-flow changes; applied to rule, probe, LLM and persistence paths. E/W regressions | Fixed for covered transformations; semantic limits documented |
| REPAIR-AUTH | P0 | A queued repair could proceed after workflow authorization changed | Parent ownership/environment/deadline/approval/autonomy rechecked before execution and persistence. W authorization revocation tests | Fixed |
| REPAIR-SCOPE | P0 | Mirroring a repaired spec could overwrite same-named specs in unrelated curated project folders | Query only project-owned curated suites; verify source project and realpath containment. W filesystem and symlink regression | Fixed |
| EDITOR-MEASURE | P1 | Parent form renders discarded controlled-node measurements, intermittently hiding all nodes | Retain React Flow measurement state; actual page form edits and browser interactions rechecked | Fixed |
| INSPECT-DATE | P2 | Recursive response redaction converted Date objects to empty objects, displaying NaN durations | Preserve JSON timestamp serialization; W regression and B assertion against NaN | Fixed |
| SEC-ARTIFACT | P0 | Raw artifact download exposed a bearer credential inside a real Playwright trace | Restricted originals, validated structured derivatives, unified authorized routes, blocked export bypasses; S/U/V pass | **Fixed for supported traces; unsupported artifacts blocked** |

### SEC-ARTIFACT: implemented security design

The original audit reproduced credential exposure in an owner-authorized trace.
The subsequent remediation was explicitly authorized. `acceptance-ui.mjs` retains
the same synthetic bearer probe: the original must contain the canary and the
download must not. No production credential or external target is used.

**Recording and retention.** The existing UI runner now executes with a temporary
config wrapper beside its original Playwright config. It preserves authentication,
projects, trace mode, and standalone failure screenshots, but disables trace-embedded
screenshots, sources, and attachments. Snapshots remain available to the sanitizer.
Output is scoped to the run directory; the wrapper is removed in `finally`. Legacy
traces and other capture paths still pass through the same download gate.

Original run evidence is never rewritten. Raw run directories are no longer served
by static handlers. Before sanitizing, the service preserves an immutable copy in
`REPORT_ROOT/.private-artifacts/<project-and-run-hash>/originals/<sha256>.zip`.
Separately hashed derivatives live under `sanitized/<policy-and-secret-set-hash>/`.
Those directories have no download route. POSIX creation modes are 0700/0600;
Windows protection also depends on the service account's existing filesystem ACLs.
No production ACL or storage configuration was changed. Failed sanitization may
retain the original for restricted diagnosis but never exposes it.

**Structured sanitization.** Policy `pw8-projection-1` supports the installed
Playwright trace version 8. It parses ZIP members, JSONL events, network records,
and stack metadata. It builds a new archive from an allowlist of structural fields:

- Action order, timing, method/class, relationships, and failure presence remain.
- URLs are parsed and replaced with stable synthetic URLs, including host/path,
  userinfo, query and fragment. Original identifiers and member names are remapped.
- Header values, cookies, queries, request/response bodies, auth state, action
  arguments/results, log messages, source paths, and free-form metadata are withheld.
- DOM text and attributes are removed/redacted; safe tag topology and validated
  delta references remain. Executable elements and external resource links cannot
  survive. Invalid/cyclic references and excessive rendered DOM expansion are blocked.
- Original resource members, including screenshots, sources, attachments and opaque
  body files, are omitted. No pixel-redaction claim is made; images are absent from
  downloadable traces. Standalone screenshots remain a separate existing capability.

The output is reparsed with CRC/size/directory validation. Every emitted member is
parsed and checked against project secrets and their URI/base64/base64url/JSON
encodings. This scan supplements structural omission; confidentiality does not
depend on recognizing names like `password` in arbitrary application payloads.
Failure to load/decrypt the project's secret set blocks the download.

Archive limits are 32 MiB input/output, 64 MiB expanded input, 8 MiB per member,
2,048 members, 200:1 compression ratio, 100,000 records, nesting depth 80, and 64
trace contexts. Snapshot expansion is capped at 50,000 nodes per snapshot. ZIP32
store/deflate are supported. Encryption, ZIP64, unsafe paths, duplicate/case-alias
members, symlinks, unsupported methods/extra fields, nested ZIP/gzip resources,
malformed JSON, unknown trace records/versions, truncated data, bad checksums,
unexpected trailing bytes, and decompression exceeding declared bounds are rejected.
No archive is extracted onto the filesystem.

**Delivery and concurrency.** Every trace request authorizes the run/project first;
workflow artifact references must also bind their TestRun to the job's project.
Reads enforce canonical-root containment, regular-file/size checks, stable file
metadata and bounded buffers. Sanitization is shared only for the same
project/run/content/policy/secret-set, with at most four distinct in-flight jobs.
Existing derivative files are never trusted as cached response bytes; each request
uses newly validated bytes. Responses use `private, no-store`, `nosniff`, and a
constant sanitized filename. Any security failure yields HTTP 422 with
`ARTIFACT_SECURITY_BLOCKED` and a fixed message containing no input values.
Only missing files permit lookup in a legacy root; security errors never do.

### Capture, retrieval and export path inventory

| Path or mechanism | Policy and verification |
|---|---|
| UI worker → `node-test-exec.ts` → Playwright config/report/test-results → evidence collector → `OperatorArtifact` | Capture wrapper, run-scoped output, unchanged original; CLI exercised in U; worker baseline regressions retained |
| Legacy Playwright runner/report/allure directories and historical run records | Same download gate applies on read; no destructive migration or historical-record rewrite |
| `/workflows/artifacts/:id` | Project owner plus artifact-job/TestRun project binding; validated sanitized copy only; U actual DB/Fastify and S foreign-run regression |
| `/runner-logs/*`, `/_static/runner-logs/*`, `/runner/runner-logs/*` | One handler and run-owner check; S concurrent/unauthorized/malformed cases and U real trace on every alias |
| `/assets/*` (Allure compatibility) | Referrer locates a run, never grants access; run owner must match; ZIP magic is checked even with another filename; S actual HTTP test |
| `/runner/test-runs/:id/report.json`, `/runner/tm/runs/:id/tests`, `/runner/test-runs/:id/logs` | Authorized bounded gateway; embedded ZIP/base64 bodies withheld; tested HTTP aliases and log redaction |
| Parsed result/analysis JSON, report/run/test contracts, workflow and Operator inspection | Structured redaction; artifact paths replaced by authorized endpoint references; historical provider URLs removed from artifact fields/metadata |
| `/_static/playwright-report/*` | Previously unscoped static output; now explicitly blocked because run ownership cannot be established |
| `/tm/generated/file`, `/tm/generated/download`, `/tm/download`, `/tm/suite/spec-content` | Source-only allowlist and canonical ownership/path checks; trace/archive content and artifact directories excluded/rejected; S actual HTTP success, denial and failure tests |
| `/debug/volume/read` | Existing debug authorization retained; bounded source preview only; evidence roots, trace content and disguised ZIPs blocked; S actual HTTP handler test |
| Signed URLs/direct object storage | No object-store SDK, upload/export provider or signed-URL issuer found in the API capture/download path. Historical HTTP/S3/GS/file/data references are suppressed in artifact contracts. Previously distributed third-party URLs cannot be revoked by this local change |
| Raw local/private object references | No static mount exposes raw run or private-copy storage; realpath checks reject cross-run links. An independently configured external proxy/volume server remains a deployment responsibility, not something certified here |

Source bundles validate all files before streaming, with 8 MB/file, 32 MB total,
2,048 files, 4,096 walked entries and depth 20. HTML/JS/CSS report assets are never
rewritten with a broad regex: embedded archives or known project-secret matches
block delivery; supported ordinary assets retain their bytes. Unscoped HTML
bundles and unsafe/unsupported evidence receive an explicit error.

**Usability and limitations.** V records all eleven required categories (bearer,
API key, session cookie, body password, URL username/password, storage state,
response data, custom project secret, snapshot text, and metadata). It first proves
each value exists in the original, then checks every downloadable member for
plain, URI and base64 variants, verifies unchanged original bytes, and opens the
derivative in the actual installed Trace Viewer. Actions, network timing/status,
redacted DOM structure, and failed-action markers work without page errors.
The tradeoff is intentional loss of original payloads, selectors, page text,
visual styling, source code, screenshots and detailed error strings. They cannot
be safely reconstructed from the download. See the official
[Trace Viewer guide](https://playwright.dev/docs/trace-viewer) and
[tracing API](https://playwright.dev/docs/api/class-tracing) for the upstream
recording/viewing interface; the supported internal schema is pinned by the local
1.58.2 implementation and live fixture, not assumed stable across future upgrades.

Live evidence: `tests/workflows/.scratch/sanitized-live-trace.zip`,
`tests/workflows/.scratch/trace-live/sanitized.zip`, and
`tests/workflows/.scratch/trace-live/trace-viewer.png`. The last screenshot shows
the sanitized failed action in Trace Viewer. Local original fixtures contain only
synthetic canaries; they are ignored by Git and are not public download artifacts.

## Files modified during this audit

The workspace already contained the Release 1 implementation. This list identifies
the audit/hardening changes; it is not a claim that all existing uncommitted files
were created during this audit.

| Area | Paths | Purpose |
|---|---|---|
| Shared execution | `packages/testmind-core/workflow/execution.js` | Secret aliases, bearer reflections, nested redaction and timestamp preservation |
| Runtime policy | `apps/api/src/lib/workflow-execution-policy.ts` | Atomic child claims, authorization watcher, repair authorization |
| Graph runtime | `apps/api/src/runner/workflow-engine.ts`, `workflow-runner.ts`, `workflow-handlers.ts` | Cancellation signals and failure-kind persistence/propagation |
| Existing test runners | `apps/api/src/runner/api-test-service.ts`, `worker.ts` | Prevent replay, abort API work, redact API response headers |
| API inspection/control | `apps/api/src/routes/workflowGraphs.ts` | Redacted version/inspection responses; terminal cancellation evidence |
| Repair safety | `apps/api/src/ai/core/action-service.ts`, `repair-policy.ts`, `repair-service.ts`, `repair-policy.test.ts` | Assertion preservation, authorization rechecks, project-scoped persistence |
| Editor | `apps/web/src/components/workflows/WorkflowEditor.tsx`, `apps/web/src/pages/WorkflowsPage.tsx` | Retain measurements; stable card identifier for browser tests |
| Existing workflow harness | `tests/workflows/operator-harness.mjs`, `integration.mjs`, `engine.test.mjs`, `adapters.test.mjs`, `editor-smoke.mjs` | Real infrastructure/fault injection support, migration fixtures, targeted regressions, expanded browser checks |
| New acceptance harness | `tests/workflows/acceptance-scenarios.mjs`, `acceptance-browser.mjs`, `acceptance-ui.mjs`, `acceptance-page.tsx`, `acceptance-auth.ts`, `repair-safety.test.mjs` | End-to-end local API/page/CLI/evidence checks and security probes |
| Commands/report | `package.json`, `docs/WORKFLOW_RELEASE1_ACCEPTANCE.md`, `docs/WORKFLOW_RELEASE1.md` | Acceptance command, findings and qualification of prior milestone report |

No Prisma schema or migration change was necessary during this hardening pass.
The existing additive Release 1 migration was tested in disposable databases only.

### Files changed for the trace security remediation

The table above records the preceding acceptance audit. This follow-up changed
only the following implementation/test/report areas; it preserves the other
pre-existing uncommitted Release 1 work.

| Area | Exact paths | Purpose |
|---|---|---|
| Archive and trace policy (new) | `apps/api/src/lib/trace-archive.ts`, `apps/api/src/lib/trace-sanitizer.ts` | Bounded ZIP parsing/writing, structured v8 projection, reference/integrity checks, secret validation |
| Artifact storage/delivery (new) | `apps/api/src/lib/artifact-service.ts`, `apps/api/src/routes/artifacts.ts` | Restricted originals, separate derivatives, authorized aliases, bounded reads, explicit security failures and diagnostic source guard |
| Capture (new helper; existing runner changes) | `apps/api/src/lib/trace-capture.ts`, `apps/api/src/runner/node-test-exec.ts`, `apps/api/src/runner/worker.ts` | Per-run capture restrictions and cleanup; forward configured trace mode |
| Route wiring/ownership | `apps/api/src/index.ts`, `apps/api/src/routes/workflowGraphs.ts`, `apps/api/src/routes/operator.ts` | Remove raw static routes; enforce artifact/job/run ownership and opaque authorized download references |
| Historical/embedded exports | `apps/api/src/lib/artifact-references.ts` (new), `apps/api/src/routes/run.ts`, `apps/api/src/routes/reports.ts`, `apps/api/src/routes/tests.ts` | Centralize raw aliases, redact embedded report content, suppress external raw-storage references |
| Source exports | `apps/api/src/lib/source-export.ts` (new), `apps/api/src/testmind/routes.ts` | Prevent archive/raw-member escape through source previews and bundles; retain source download capability |
| New security harness | `tests/workflows/artifact-harness.mjs`, `tests/workflows/trace-security.test.mjs`, `tests/workflows/trace-live.mjs` | Real handlers, synthetic credential matrix, archive/authorization/failure/concurrency coverage, real recorder and Trace Viewer |
| Existing acceptance/regression harness | `tests/workflows/acceptance-ui.mjs`, `tests/workflows/integration.mjs`, `tests/workflows/routes.test.mjs` | Require secure download behavior, exercise capture wrapper in CLI, register actual gateway, preserve route regression dependencies |
| Commands/documentation | `package.json`, `docs/WORKFLOW_RELEASE1_ACCEPTANCE.md`, `docs/WORKFLOW_RELEASE1.md` | Reproducible security commands and current acceptance decision |

## Commands and final results

Run from the repository root. On Windows use `pnpm.cmd`. Docker, the local test
images, the generated Prisma client, and Playwright Chromium must already be
available. These tests never select the configured application database.

```powershell
pnpm.cmd test:workflows
pnpm.cmd test:workflow-trace-security
pnpm.cmd test:workflow-trace-live
node --import tsx --test apps/api/src/lib/security-approval-policy.test.ts apps/api/src/lib/autonomous-planner.test.ts apps/api/src/lib/investigator.test.ts apps/api/src/lib/safe-fetch.security.test.ts apps/api/src/ai/core/repair-policy.test.ts apps/api/src/ai/core/repair-executor.test.ts apps/api/src/testmind/runtime/locator-store.test.ts apps/api/src/lib/generatedSpecs.test.ts apps/api/src/lib/operator-decisions.test.ts
pnpm.cmd exec tsc --noEmit -p apps/api/tsconfig.json
pnpm.cmd --filter testmind-web exec tsc --noEmit
pnpm.cmd --filter testmind-web exec vite build
pnpm.cmd test:workflow-editor
pnpm.cmd test:workflow-acceptance
git diff --check
```

| Check | Final result |
|---|---|
| Workflow regressions | 142 passed, including all 27 trace-security cases; 0 failed/skipped/TODO |
| Trace-security regressions | All 27 passed within the final workflow run; focused command also exercised during hardening |
| Live recorder / Trace Viewer | Passed; all eleven credential categories present in original, absent from every sanitized member; original unchanged; action, network, DOM and failure views usable |
| Selected existing regressions | 78 passed; 0 failed/skipped/TODO |
| API TypeScript | Passed |
| Frontend TypeScript | Passed |
| Production frontend build | Passed, warnings below |
| Editor interaction suite | Passed |
| Disposable migration/queue foundation | Five foundation scenarios passed within acceptance command |
| Extended local acceptance | 19 scenarios passed; 0 failed; exit 0, including SEC-ARTIFACT |
| Diff whitespace check | Passed; Git emitted Windows line-ending notices |

Intermediate failures were investigated: an early UI output-directory fixture used
a disallowed `tests` path segment and was moved to the ignored `.tmp` directory;
the test-only auth/JSX configuration was corrected; a browser repeat exposed the
actual editor measurement bug described above. The pointer connection regression
needed two render frames after Fit View before measuring drag coordinates. The
final interaction run passes without forced clicks or relaxed graph assertions.
The failed-run browser check also waits for the new run to appear before selecting
its inspector, avoiding accidentally reopening the previous successful run.
After the final run, Docker listed no remaining containers with the audit's
`testmind.workflow.test` label. Synthetic files under `.scratch` and `.tmp` remain
available as local evidence.

During the trace remediation, the first live input exposed a valid empty DOM node
(`['BODY']`) that the initial projection rejected. The parser now supports that
recorder shape, with a dedicated regression. The source-preview HTTP test exposed
a text/plain error-response mismatch; the security response now explicitly uses
JSON. The viewer fixture was corrected to use the installed viewer's local-file
endpoint and counted Errors tab. The final live run and full regression results
above supersede these intermediate failures; no failing assertion was suppressed.

Final remediation command logs are under `tests/workflows/.scratch/`:
`remediation-regression.log`, `remediation-existing.log`,
`remediation-typecheck.log`, `remediation-web-typecheck.log`,
`remediation-web-build.log`, `remediation-editor.log`,
`remediation-acceptance.log`, `remediation-diff-check.log`, and `trace-live.log`.
`acceptance-results.json` contains exactly 19 PASS entries. The five migration/queue
foundation scenarios appear separately in the acceptance console log.
`docker ps -a --filter label=testmind.workflow.test --format '{{.Names}}'` returned
no containers after the final run. The application database/configuration was not
selected by these disposable integration tests.

### Browser and generated evidence

Local generated evidence is ignored by Git and reproducible with the commands
above. It contains only synthetic fixture data:

- `tests/workflows/editor-smoke.png`: editor after interaction checks.
- `tests/workflows/.scratch/acceptance-browser.png`: actual saved/running workflow
  page and successful inspector.
- `tests/workflows/.scratch/acceptance-browser-failed-run.png`: failed assertion
  inspector.
- `tests/workflows/.scratch/browser-report.json`: report downloaded through the UI.
- `tests/workflows/.scratch/acceptance-results.json`: per-scenario audit results.
- `tests/workflows/.scratch/acceptance-console.log`, `regression-console.log`,
  `existing-regression.log`, `editor-console.log`, `api-typecheck.log`,
  `web-typecheck.log`, `web-build.log`: command evidence.
- `tests/workflows/.scratch/runner-logs/<fixture-run>/`: generated report, CLI log,
  screenshot, original trace and page-signal artifacts. The original contains the
  synthetic canary; its separately downloaded sanitized copy does not.
- `tests/workflows/.scratch/.private-artifacts/`: restricted original and sanitized
  derivative fixtures created by the actual artifact service.
- `tests/workflows/.scratch/trace-live/trace-viewer.png`: actual viewer after opening
  the sanitized failed action; `sanitized.zip` is the corresponding derivative.
- `.tmp/workflow-ui-acceptance-*/`: generated local Playwright fixture specs.

## Migration, durability and compatibility findings

The integration test reconstructs the pre-Release-1 schema from pinned revision
`c696baa1f2ae8bc01f2ce0eed82c4e1c2299ab09`, seeds legacy configurations, successful
history and pending/resolved workflow approvals, then applies the actual
`20261109120000_workflow_graph_foundation/migration.sql`. The records remain intact.
This tests the upgrade, not merely an empty database created from the new schema.

The migration adds the workflow job enum value, archive timestamp, version table,
run/version context, node identity/attempt fields, encrypted state, foreign keys
and unique indexes. It does not drop legacy columns/tables or backfill/delete
historical runs. Nullable version/node references preserve legacy rows. Existing
workflow/run status and creation-time indexes remain available; the new unique
attempt index also supports run-prefix lookups. Version digests are unique per
workflow. Direct database administration can still change version rows; the API
does not expose version mutation.

Real queue tests verify graceful restart, dispatch reconciliation, retained
completed delivery, concurrent graphs and an ambiguous external-write scenario.
Three crash cases inject exceptions or checkpoint states around actual local
services; none is presented as SIGKILL certification. Interrupted already-claimed
child work is not automatically replayed. It can remain running until the parent
deadline and needs operational diagnosis; safety is favored over automatic liveness.

The legacy Operator and adapters remain present and regression-tested. Historical
Operator approval tables were not modified by the migration; representative
workflow approval fields were checked live. A production-scale migration,
existing large-database lock-duration measurement, and full legacy-suite execution
after upgrade remain untested.

## Security review and production considerations

Project ownership protects graph runs, versions, attempts and artifact downloads
in the tested routes. Cross-project repair mirroring is now blocked by database
ownership and filesystem containment. Private execution state is encrypted and
excluded from inspector responses. Structured redaction has broader coverage, but
does not establish pixel confidentiality for standalone screenshots/videos or every
legacy log encoding. **The confirmed downloadable-trace exposure is fixed:**
supported traces use validated derivatives and unsupported traces are blocked.

Environment fingerprints, approvals, limits and current authorization remain
checked during execution and before repair persistence. Outbound HTTP is restricted
by the existing safe-fetch policy and selected environment origin. Private-network
access was enabled only inside the isolated local test dependency; no application
environment configuration was changed. DNS preflight validation is not a tested
socket-pinning guarantee. Curated test code still runs in the existing trusted-code
model, without a new OS sandbox.

Do not deploy this result as an accepted release. Before any approved rollout:

1. Preserve the implemented trace gateway and restrict raw storage at the host/proxy
   boundary. Review existing externally distributed artifacts/URLs and retention
   separately; this patch does not revoke copies already outside TestMind. Complete
   the outstanding confidentiality assessment for non-trace artifacts.
2. Complete target-specific authenticated acceptance and the live autonomous
   repair/targeted/full-suite chain. Verify real cancellation of browser processes.
3. Rehearse the additive migration against a representative backup, measure locks,
   and ensure backup/restore and stable encryption-key access.
4. Apply the additive migration and generate the matching Prisma client before new
   workers/API code can use graph fields. Coordinate worker versions; an old worker
   must not consume new graph jobs it does not understand.
5. Roll back application code only after draining/pausing graph work. Preserve new
   tables, columns and encrypted records. Dropping them loses graph history; the
   PostgreSQL enum addition is not a simple reversible migration. No down migration
   or production rollback was run here.

Frontend warnings are **P2, nonblocking for functional acceptance**: the main JS
chunk is about 1,783.65 kB (498.47 kB gzip), the logo SVG about 2,943.14 kB
(1,102.77 kB gzip), and the xlsx chunk 429.19 kB. Route-level splitting and logo
optimization should be planned against an actual performance budget. The
Browserslist database reports approximately ten months of age; update it in a
separate dependency change and recheck supported browsers. No performance budget
or cross-browser certification was inferred from a passing build. The isolated
editor harness also emits a Tailwind content warning; the full-page fixture and
production build supply content configuration.

## Release 2 dependency readiness

Graph contracts, registry, adapters and scoped execution provide a useful Release
2 foundation. **Release 2 is not cleared to begin on the basis of this audit.**
SEC-ARTIFACT now passes for supported traces, but the full live autonomous
discovery/repair/targeted/full-suite chain, non-trace artifact confidentiality, and
the other PARTIAL/NOT TESTED criteria above remain unverified. This remediation
does not turn those requirements into exemptions. Release 1 remains NOT ACCEPTED
until all mandatory criteria are verified. Python/pytest and RAG/vector/Chroma
implementation remain unstarted. Work stops here at this acceptance decision;
there is no deployment, production configuration change or Release 2 work.
